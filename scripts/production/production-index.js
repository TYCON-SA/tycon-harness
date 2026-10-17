#!/usr/bin/env node
/**
 * production-index.js — qué servidores de base conoce esta máquina, y cuáles son de producción.
 *
 * POR QUÉ UN ÍNDICE Y NO UN CATÁLOGO CENTRAL (story 6.1, AC 2): un catálogo único en el arnés le
 * mostraría los servidores de todos los clientes a cualquiera que lo clone. La declaración vive en
 * `<repo>/.tycon/production.json`, o sea que sólo llega a quien tiene permiso sobre ESE repo. El
 * freno, en cambio, corre en carpetas que no son un repo (la sesión del incidente corría en una
 * así), así que junta las declaraciones de los repos clonados bajo la raíz de repos en un índice
 * local que nunca viaja.
 *
 * PRODUCCIÓN PEGAJOSA (AC 4): un host que alguna vez se vio como `produccion` NO vuelve a
 * `no-produccion` porque alguien reescriba un archivo o borre el índice. Esa memoria vive aparte
 * (`production-memory.json`), con huella, y sólo la baja la puerta con `--reclasificar`, que
 * primero abre el cuadro de aprobación.
 *
 * ESCRITURA DOBLE (story 8.9, tanda P · 2026-09-30): el renombre a inglés cambió los nombres del catálogo
 * (`.tycon/produccion.json` → `.tycon/production.json`, claves `servidores/ambiente/llavero/puerto` →
 * `servers/environment/keychain/port`), del índice y de la memoria. La copia del freno que corre de verdad vive en
 * /opt/tycon y sólo cambia cuando la persona reinstala con sudo; hasta que TODAS las máquinas autorizadas reinstalen,
 * conviven la copia vieja (lee los nombres viejos) y ésta. Por eso acá: el índice y la memoria se ESCRIBEN con los dos
 * nombres (mismo contenido: la copia vieja lee el índice que arma ésta), la memoria se LEE de los dos (se juntan: es
 * pegajosa) y el catálogo se lee con los dos nombres y las dos claves. Un catálogo con los dos nombres y contenidos
 * distintos, o una clave con sus dos nombres y valores distintos, es un error de ESE repo: sus hosts quedan
 * desconocidos, y lo desconocido se frena. Los nombres viejos están escritos acá y no en el mapa a propósito: este
 * archivo corre desde /opt, y un mapa que no se pudiera leer no puede apagar la mitad vieja. La escritura doble se
 * apaga en un commit aparte, con todas las máquinas «al día» (AC 49).
 *
 * LÍMITE HONESTO: la huella detecta una EDICIÓN A MANO, no a un adversario (quien puede escribir el
 * archivo puede recalcularla). Lo que impide escribir estos archivos es el freno (AC 9); la huella
 * es la segunda capa, la que hace ruidoso el toqueteo.
 *
 * Uso:
 *   node production-index.js --json        # construye y lo imprime (no guarda)
 *   node production-index.js --reindex     # construye y lo guarda
 *   node production-index.js --report      # en castellano: raíz, catálogos, hosts, avisos
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PROFUNDIDAD = 5;
const SALTEAR = new Set(['node_modules', 'bin', 'obj', 'dist', 'build', '.git', 'vendor', 'Library', 'Pods', '.venv', 'venv', '__pycache__']);
const SUFIJO_AZURE = '.database.windows.net';
const LOCALES = new Set(['localhost', '127.0.0.1', '::1', '(local)', '.', '(localdb)']);

// la carpeta del estado la sabe scripts/setup/harness/tycon-home.js (story 8.23, tanda D): se carga si está al lado (en el
// repo, y en /opt/tycon/setup/harness/ por el instalador del freno); si no, la de siempre
const dirDatos = (home) => {
  try { const TH = require(path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js')); if (typeof TH.stateDir === 'function') return TH.stateDir(home || os.homedir()); } catch (_) { /* la de siempre */ }
  return path.join(home || os.homedir(), '.claude', '.tycon-pipeline');
};
const rutaIndice = (home) => path.join(dirDatos(home), 'production-index.json');
const rutaMemoria = (home) => path.join(dirDatos(home), 'production-memory.json');
// los nombres de antes del renombre (escritura doble, ver la cabecera)
const rutaIndiceVieja = (home) => path.join(dirDatos(home), 'produccion-indice.json');
const rutaMemoriaVieja = (home) => path.join(dirDatos(home), 'produccion-memoria.json');
const CATALOGO = path.join('.tycon', 'production.json');
const CATALOGO_VIEJO = path.join('.tycon', 'produccion.json');

/** Igualdad por contenido, sin importar el orden de las claves de un objeto. */
function mismoValor(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => mismoValor(x, b[i]));
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && mismoValor(a[k], b[k]));
}

/** El valor de una clave con su nombre nuevo o el viejo. Los dos con valores distintos → `conflicto`. */
function clave(obj, nuevo, viejo) {
  const tieneN = Object.prototype.hasOwnProperty.call(obj, nuevo);
  const tieneV = Object.prototype.hasOwnProperty.call(obj, viejo);
  if (tieneN && tieneV && !mismoValor(obj[nuevo], obj[viejo])) return { conflicto: `«${nuevo}» y su nombre viejo «${viejo}» tienen valores distintos` };
  return { valor: tieneN ? obj[nuevo] : obj[viejo] };
}

/** El catálogo de un repo, con los dos nombres: { texto, archivo } · { error, archivo } · null si no declara nada. */
function leerCatalogo(repo) {
  const nuevo = path.join(repo, CATALOGO);
  const viejo = path.join(repo, CATALOGO_VIEJO);
  const leer = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return e && e.code === 'ENOENT' ? null : { ilegible: e }; } };
  const tn = leer(nuevo);
  const tv = leer(viejo);
  for (const [t, f] of [[tn, nuevo], [tv, viejo]]) {
    if (t && typeof t === 'object') return { error: `no se puede leer (${t.ilegible.code || t.ilegible.message})`, archivo: f };
  }
  if (tn !== null && tv !== null && tn !== tv) return { error: `tiene el catálogo con los dos nombres (${CATALOGO} y ${CATALOGO_VIEJO}) y contenidos distintos: dejá uno solo`, archivo: nuevo };
  if (tn !== null) return { texto: tn, archivo: nuevo };
  if (tv !== null) return { texto: tv, archivo: viejo };
  return null;
}

/** Host comparable: sin `tcp:`, sin puerto, sin instancia, sin mayúsculas. Un nombre corto de Azure se completa. */
function normalizar(valor) {
  if (typeof valor !== 'string') return null;
  let h = valor.trim().replace(/^tcp:/i, '').replace(/^"+|"+$/g, '');
  h = h.split(',')[0].split('\\')[0].trim().replace(/\.$/, '').toLowerCase();
  if (!h) return null;
  if (LOCALES.has(h) || /^127\./.test(h)) return h;                 // locales: se reconocen y no se juzgan
  if (!h.includes('.')) h += SUFIJO_AZURE;                          // `--server acme-sql` es ese host
  if (!/^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/.test(h)) return null;
  return h;
}
const esLocal = (host) => !!host && (LOCALES.has(host) || /^127\./.test(host));

const huellaDe = (obj) => crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex');

/** Los repos git bajo `raiz`, hasta PROFUNDIDAD niveles, sin entrar a node_modules y compañía. */
function reposBajo(raiz) {
  const repos = [];
  const cola = [{ dir: raiz, nivel: 0 }];
  while (cola.length) {
    const { dir, nivel } = cola.shift();
    let hijos;
    try { hijos = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    const esRepo = hijos.some((h) => h.name === '.git');
    if (esRepo) { repos.push(dir); continue; }                      // un repo no contiene otros: no se baja más
    if (nivel >= PROFUNDIDAD) continue;
    for (const h of hijos) {
      if (!h.isDirectory() || SALTEAR.has(h.name) || (h.name.startsWith('.') && h.name !== '.tycon')) continue;
      cola.push({ dir: path.join(dir, h.name), nivel: nivel + 1 });
    }
  }
  return repos;
}

/**
 * Construye el índice leyendo los catálogos de los repos clonados bajo la raíz.
 * @returns {{generado:string, raiz:string, fuente:string, catalogos:object[], errores:object[],
 *            hosts:Record<string,{ambiente:string, repos:string[], llavero?:string}>, memoria:string[],
 *            memoria_alterada:boolean, huella:string}}
 */
function construir(opts = {}) {
  const home = opts.home || os.homedir();
  let raiz = opts.raiz || process.env.TYCON_REPOS_ROOT || '';
  let fuente = raiz ? 'env' : '';
  let configRota = null;
  if (!raiz) {
    const { resolveReposRoot } = require(path.join(__dirname, '..', 'lib', 'repos-root.js'));
    try {
      const r = resolveReposRoot(undefined, { home });
      raiz = r.root; fuente = r.fuente;
    } catch (e) {
      if (e && e.name === 'ConfigError') {
        // AC 2 de la story 8.3: el freno de producción NO se apaga ni deniega por un archivo de configuración roto.
        // El índice se arma SIN el nivel de la máquina (exactamente como antes de la 8.3) y LLEVA el error: el
        // aviso de arranque lo muestra en cada sesión hasta que se arregle.
        configRota = e;
        try { const r = resolveReposRoot(undefined, { home, sinConfig: true }); raiz = r.root; fuente = r.fuente; }
        catch { raiz = null; fuente = 'sin-raiz'; }
      } else { raiz = null; fuente = 'sin-raiz'; }
    }
  }
  if (!raiz) fuente = 'sin-raiz';

  const hosts = Object.create(null);
  const catalogos = [];
  const errores = [];
  if (configRota) {
    errores.push({ repo: '—', archivo: ((configRota.errores || [])[0] || {}).archivo || path.join(home, '.claude', 'tycon.json'),
      motivo: `configuración del arnés ROTA — el índice se armó sin ~/.claude/tycon.json; arreglalo (node scripts/lib/tycon-config.js validate): ${(configRota.errores || []).map((x) => `${x.archivo}${x.clave ? ` · ${x.clave}` : ''} · ${x.motivo}`).join(' | ')}` });
  }
  // Sin raíz no se mira ningún repo, y el índice lo dice como error (story 8.3, AC 6): nunca una carpeta inventada.
  if (!raiz) errores.push({ repo: '—', archivo: '—', motivo: 'sin raíz de repos: no se miró ningún repo (definí TYCON_REPOS_ROOT o paths.repos en ~/.claude/tycon.json)' });
  for (const repo of raiz ? reposBajo(raiz) : []) {
    const cat = leerCatalogo(repo);
    if (!cat) continue;                                                        // el repo no declara nada
    const { archivo } = cat;
    if (cat.error) { errores.push({ repo: path.basename(repo), archivo, motivo: cat.error }); continue; }
    const texto = cat.texto;
    let doc;
    try { doc = JSON.parse(texto); } catch (e) {
      // AC 3: ilegible vuelve DESCONOCIDOS los hosts de ESE repo, no rompe el resto del índice.
      errores.push({ repo: path.basename(repo), archivo, motivo: `no es JSON válido (${e.message})` });
      continue;
    }
    const raizDoc = doc && typeof doc === 'object' && !Array.isArray(doc) ? clave(doc, 'servers', 'servidores') : { valor: null };
    if (raizDoc.conflicto) { errores.push({ repo: path.basename(repo), archivo, motivo: raizDoc.conflicto }); continue; }
    const lista = Array.isArray(raizDoc.valor) ? raizDoc.valor : null;
    if (!lista) { errores.push({ repo: path.basename(repo), archivo, motivo: 'no tiene una lista «servers»' }); continue; }
    catalogos.push({ repo: path.basename(repo), archivo, servidores: lista.length });
    for (const s0 of lista) {
      // las claves con su nombre nuevo o el viejo; el índice guarda siempre las de siempre (la copia vieja de /opt lo lee)
      let s = s0;
      if (s0 && typeof s0 === 'object' && !Array.isArray(s0)) {
        const campos = { ambiente: clave(s0, 'environment', 'ambiente'), llavero: clave(s0, 'keychain', 'llavero'), puerto: clave(s0, 'port', 'puerto') };
        const choque = Object.values(campos).find((c) => c.conflicto);
        if (choque) { errores.push({ repo: path.basename(repo), archivo, motivo: `servidor mal declarado: ${choque.conflicto} (${JSON.stringify(s0.host)})` }); continue; }
        s = { host: s0.host, base: s0.base, ambiente: campos.ambiente.valor, llavero: campos.llavero.valor, puerto: campos.puerto.valor };
      }
      const host = normalizar(s && s.host);
      if (!host || (s.ambiente !== 'produccion' && s.ambiente !== 'no-produccion')) {
        errores.push({ repo: path.basename(repo), archivo, motivo: `servidor mal declarado: ${JSON.stringify(s0)}` });
        continue;
      }
      const previo = hosts[host];
      if (!previo) {
        hosts[host] = { ambiente: s.ambiente, repos: [path.basename(repo)] };
        if (s.llavero) hosts[host].llavero = s.llavero;
        // `base`: a qué base se conecta la puerta. En Azure SQL no hay `USE` ni nombres de tres partes,
        // así que sin esto el cliente entra a `master` y toda tabla es «Invalid object name» (medido
        // contra un servidor interno el 2026-09-15, con la clave ya bien — guides/maintaining/incident-log.md#case-azure-sql-enters-master-2026-09-15).
        if (typeof s.base === 'string' && s.base) hosts[host].base = s.base;
        // `puerto`: sólo cuando el servidor NO escucha en el 1433. La puerta lo pega al host al
        // conectarse; acá viaja aparte para que el host siga siendo una sola escritura.
        if (Number.isInteger(s.puerto)) hosts[host].puerto = s.puerto;
      } else {
        if (!previo.repos.includes(path.basename(repo))) previo.repos.push(path.basename(repo));
        // AC 3: dos repos, ambientes distintos → gana producción (y el mensaje nombra los dos)
        if (s.ambiente === 'produccion') {
          previo.ambiente = 'produccion';
          if (s.llavero) previo.llavero = s.llavero;
          if (typeof s.base === 'string' && s.base) previo.base = s.base;
        }
      }
    }
  }

  // ── memoria pegajosa (AC 4) ────────────────────────────────────────────────────────────────
  const { memoria, alterada } = leerMemoria(home);
  for (const host of memoria) {
    if (!hosts[host]) hosts[host] = { ambiente: 'produccion', repos: [], desde: 'memoria' };
    else if (hosts[host].ambiente !== 'produccion') { hosts[host].ambiente = 'produccion'; hosts[host].desde = 'memoria'; }
  }
  const memoriaNueva = [...new Set([...memoria, ...Object.keys(hosts).filter((h) => hosts[h].ambiente === 'produccion')])].sort();

  const indice = {
    generado: new Date().toISOString(),
    raiz, fuente,
    catalogos, errores, hosts,
    memoria: memoriaNueva,
    memoria_alterada: alterada,
  };
  indice.huella = huellaDe({ ...indice, huella: undefined });
  return indice;
}

/** Una memoria: { existe, hosts, alterada }. Ilegible (permisos, JSON roto) cuenta como existente y alterada. */
function leerUnaMemoria(ruta) {
  let texto;
  try { texto = fs.readFileSync(ruta, 'utf8'); } catch (e) {
    return e && e.code === 'ENOENT' ? { existe: false, hosts: [], alterada: false } : { existe: true, hosts: [], alterada: true };
  }
  let doc;
  try { doc = JSON.parse(texto); } catch { return { existe: true, hosts: [], alterada: true }; }
  const hosts = Array.isArray(doc && doc.produccion) ? doc.produccion.filter((h) => typeof h === 'string') : [];
  return { existe: true, hosts, alterada: !doc || doc.huella !== huellaDe({ produccion: hosts }) };
}

/** La memoria que guarda cada índice (los dos nombres), junta. Un índice que no está o no se lee no aporta nada. */
function memoriaDeIndices(home) {
  const hosts = [];
  for (const ruta of [rutaIndice(home), rutaIndiceVieja(home)]) {
    try {
      const idx = JSON.parse(fs.readFileSync(ruta, 'utf8'));
      if (Array.isArray(idx.memoria)) hosts.push(...idx.memoria.filter((h) => typeof h === 'string'));
    } catch { /* ese índice no está o no se lee: el otro, o nada */ }
  }
  return [...new Set(hosts)];
}

function leerMemoria(home) {
  // Las dos memorias, la nueva y la de antes del renombre, SE JUNTAN (escritura doble, ver la cabecera): la copia vieja
  // de /opt sigue escribiendo la suya, y lo que aprendió no se puede perder en la nueva.
  //
  // 🔴 Y se juntan SIEMPRE con la memoria que guarda cada índice (los dos). Borrar una memoria —o romperla— para destrabar
  // un host de producción era el escape que la copia dentro del índice existe para cerrar (pase adversarial del
  // 2026-09-15). La primera versión de la escritura doble recuperaba del índice sólo si faltaban LAS DOS memorias, y sólo
  // del primer índice con algo: una memoria rota, o la vieja borrada con un host que la nueva no tenía, perdía ese host
  // en silencio (pase adversarial de la tanda P, 2026-09-30, reproducido). Juntar sólo suma hosts de producción: nunca
  // baja ninguno. Bajar uno es `tycon-prod-sql --reclasificar`, que reescribe las memorias y los índices.
  const nueva = leerUnaMemoria(rutaMemoria(home));
  const vieja = leerUnaMemoria(rutaMemoriaVieja(home));
  const deIndices = memoriaDeIndices(home);
  const enMemorias = new Set([...nueva.hosts, ...vieja.hosts]);
  // 🔴 «No está» y «está pero no lo puedo leer» NO son lo mismo: un archivo ilegible (permisos, JSON roto) cuenta como
  // memoria alterada, nunca como «primera vez, nada que recordar» (revisores del Step 5, 2026-09-15).
  let alterada = nueva.alterada || vieja.alterada;
  // las dos borradas con un índice que recuerda algo: alguien las borró (la primera vez no hay índice)
  if (!nueva.existe && !vieja.existe && deIndices.length) alterada = true;
  // la vieja borrada y la nueva presente: el arnés nuevo escribe siempre las dos, así que falta porque alguien la borró;
  // se dice si se perdía algo. (La nueva que falta con la vieja presente es la primera vez después del renombre.)
  if (!vieja.existe && nueva.existe && deIndices.some((h) => !enMemorias.has(h))) alterada = true;
  return { memoria: [...new Set([...enMemorias, ...deIndices])].sort(), alterada };
}

/** Escribe `texto` en las dos rutas, cada una por su temporal y rename (nunca se ve un archivo a medias). */
function escribirDoble(rutas, texto) {
  for (const ruta of rutas) {
    const tmp = ruta + '.tmp';
    fs.writeFileSync(tmp, texto); fs.renameSync(tmp, ruta);
  }
}

function guardar(indice, home, opts = {}) {
  const dir = dirDatos(home);
  fs.mkdirSync(dir, { recursive: true });
  // el índice con los dos nombres y el MISMO contenido: la copia vieja de /opt lee el suyo y lo encuentra fresco
  escribirDoble([rutaIndice(home), rutaIndiceVieja(home)], JSON.stringify(indice, null, 2));
  // 🔴 Una memoria alterada NO se vuelve a sellar sola. Antes, la misma lectura que detectaba el
  // toqueteo reescribía el archivo con una huella nueva, y a la lectura siguiente ya no figuraba nada
  // (revisores del Step 5, 2026-09-15, probado). La alteración queda a la vista hasta que una persona
  // la resuelve por la puerta (`tycon-prod-sql --verificar`, que pasa por el cuadro de aprobación).
  if (indice.memoria_alterada && !opts.resellar) return indice;
  const mem = { produccion: indice.memoria };
  mem.huella = huellaDe({ produccion: indice.memoria });
  escribirDoble([rutaMemoria(home), rutaMemoriaVieja(home)], JSON.stringify(mem, null, 2));
  return indice;
}

const VIGENCIA_MS = 60 * 1000;   // el hook regenera a lo sumo una vez por minuto (AC 2)

/** El índice utilizable: el guardado si está fresco y su huella cierra; si no, se reconstruye. */
function leer(opts = {}) {
  const home = opts.home || os.homedir();
  if (!opts.forzar) {
    try {
      // el nuevo; si todavía no está (la primera vez después del renombre), el de antes
      let texto;
      try { texto = fs.readFileSync(rutaIndice(home), 'utf8'); } catch { texto = fs.readFileSync(rutaIndiceVieja(home), 'utf8'); }
      const doc = JSON.parse(texto);
      const esperada = huellaDe({ ...doc, huella: undefined });
      const fresco = Date.now() - Date.parse(doc.generado) < VIGENCIA_MS;
      if (doc.huella === esperada && fresco) return doc;
      // huella que no cierra = lo tocaron a mano; se regenera, y la memoria de producción se conserva
    } catch { /* no hay índice, o es ilegible: se construye */ }
  }
  return guardar(construir({ home, raiz: opts.raiz }), home);
}

/** @returns {{estado:'produccion'|'no-produccion'|'desconocido', repos:string[], llavero?:string, base?:string}} */
function clasificar(host, indice) {
  const h = normalizar(host);
  if (!h) return { estado: 'desconocido', repos: [] };
  if (esLocal(h)) return { estado: 'no-produccion', repos: [], local: true };
  const e = indice && indice.hosts && indice.hosts[h];
  if (!e) return { estado: 'desconocido', repos: [] };
  return { estado: e.ambiente, repos: e.repos || [], llavero: e.llavero, base: e.base, puerto: e.puerto, desde: e.desde };
}

function main(argv) {
  const home = process.env.HOME || os.homedir();
  if (argv.includes('--json')) { console.log(JSON.stringify(construir({ home }), null, 2)); return 0; }
  if (argv.includes('--reindex')) { const i = guardar(construir({ home }), home); console.log(JSON.stringify({ hosts: Object.keys(i.hosts).length, catalogos: i.catalogos.length, raiz: i.raiz, fuente: i.fuente }, null, 2)); return 0; }
  const i = construir({ home });
  console.log(`raíz de repos: ${i.raiz} (${i.fuente})`);
  console.log(`catálogos: ${i.catalogos.length}${i.catalogos.length ? ' — ' + i.catalogos.map((c) => c.repo).join(', ') : ''}`);
  const prod = Object.entries(i.hosts).filter(([, v]) => v.ambiente === 'produccion');
  console.log(`servidores de producción: ${prod.length}${prod.length ? ' — ' + prod.map(([h]) => h).join(', ') : ''}`);
  console.log(`declarados no-producción: ${Object.values(i.hosts).filter((v) => v.ambiente === 'no-produccion').length}`);
  if (i.errores.length) { console.log('avisos:'); for (const e of i.errores) console.log(`   · ${e.repo}: ${e.motivo}`); }
  if (i.memoria_alterada) console.log('🔴 la memoria de producción fue tocada a mano (la huella no cierra)');
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { construir, leer, guardar, clasificar, normalizar, esLocal, huellaDe, rutaIndice, rutaMemoria, rutaIndiceVieja, rutaMemoriaVieja, reposBajo, CATALOGO, CATALOGO_VIEJO };
