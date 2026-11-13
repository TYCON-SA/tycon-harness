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
 * (`production-memory.json`), con huella, y sólo la baja la puerta con `--reclassify`, que
 * primero abre el cuadro de aprobación.
 *
 * LOS NOMBRES DE ANTES: el renombre a inglés cambió los nombres del catálogo (`.tycon/produccion.json` →
 * `.tycon/production.json`, claves `servidores/ambiente/llavero/puerto` → `servers/environment/keychain/port`), del
 * índice y de la memoria. El índice y la memoria se escriben sólo con el nombre nuevo. Los viejos se pasan UNA vez:
 * al regenerar, lo que marcan la memoria y el índice viejos se suma a la memoria nueva (sumar sólo agrega servidores de
 * producción), se guarda la nueva y recién entonces se borran los viejos. Desde ahí nada los lee, así que un servidor
 * bajado con la puerta no vuelve desde un archivo viejo. Una memoria vieja que no se lee o cuya huella no cierra no se
 * borra: suma lo legible y deja el índice alterado hasta que la puerta lo resuelve (`--reclassify`, o `--verify` cuando
 * lo único tocado es lo de antes). El catálogo, en cambio, se sigue leyendo con los dos nombres y las dos claves: los
 * productos lo migran aparte. Un catálogo con los dos nombres y contenidos distintos, o una clave con sus dos nombres y
 * valores distintos, es un error de ESE repo: sus hosts quedan desconocidos, y lo desconocido se frena. Los nombres
 * viejos están escritos acá y no en el mapa a propósito: este archivo corre desde /opt, y un mapa que no se pudiera
 * leer no puede apagar la lectura del catálogo viejo.
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
// los nombres de antes del renombre: sólo se leen para pasarlos una vez a los nuevos (ver la cabecera)
const rutaIndiceVieja = (home) => path.join(dirDatos(home), 'produccion-indice.json');
const rutaMemoriaVieja = (home) => path.join(dirDatos(home), 'produccion-memoria.json');
// El valor de `environment` también va en inglés («production», «non-production»); el índice guarda siempre el de antes:
// es su vocabulario interno, el que leen el freno y su copia en /opt, y cambiarlo cambiaría el formato del índice.
const AMBIENTE_DE_ANTES = { production: 'produccion', 'non-production': 'no-produccion' };
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
        s = { host: s0.host, base: s0.base, ambiente: AMBIENTE_DE_ANTES[campos.ambiente.valor] || campos.ambiente.valor, llavero: campos.llavero.valor, puerto: campos.puerto.valor };
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

/**
 * El índice de una ruta: { existe, legible, hosts, alterada } con los hosts de la memoria que guarda adentro y si ya
 * la daba por alterada.
 */
function leerUnIndice(ruta) {
  let texto;
  try { texto = fs.readFileSync(ruta, 'utf8'); } catch (e) {
    return e && e.code === 'ENOENT' ? { existe: false, legible: true, hosts: [], alterada: false } : { existe: true, legible: false, hosts: [], alterada: false };
  }
  try {
    const idx = JSON.parse(texto);
    return {
      existe: true, legible: true,
      hosts: Array.isArray(idx && idx.memoria) ? idx.memoria.filter((h) => typeof h === 'string') : [],
      alterada: Boolean(idx && idx.memoria_alterada === true),
    };
  } catch { return { existe: true, legible: false, hosts: [], alterada: false }; }
}

function leerMemoria(home) {
  // La memoria nueva SE JUNTA con la del nombre viejo y con la que guarda cada índice, hasta que lo viejo se
  // pasa a lo nuevo y se borra (ver la cabecera y `retirarViejos`).
  //
  // 🔴 Se juntan SIEMPRE con la memoria que guarda cada índice. Borrar una memoria —o romperla— para destrabar un host
  // de producción era el escape que la copia dentro del índice existe para cerrar (pase adversarial del 2026-09-15).
  // Juntar sólo suma hosts de producción: nunca baja ninguno. Bajar uno es `tycon-prod-sql --reclassify`, que reescribe
  // la memoria y el índice y borra lo de antes.
  const nueva = leerUnaMemoria(rutaMemoria(home));
  const vieja = leerUnaMemoria(rutaMemoriaVieja(home));
  const indice = leerUnIndice(rutaIndice(home));
  const indiceViejo = leerUnIndice(rutaIndiceVieja(home));
  const deIndices = [...new Set([...indice.hosts, ...indiceViejo.hosts])];
  const enMemorias = new Set([...nueva.hosts, ...vieja.hosts]);
  // 🔴 «No está» y «está pero no lo puedo leer» NO son lo mismo: un archivo ilegible (permisos, JSON roto) cuenta como
  // memoria alterada, nunca como «primera vez, nada que recordar». Vale también para los índices, que guardan su copia
  // de la memoria. Y una alteración que el índice ya anotó sigue hasta que la puerta la resuelve: si no, borrar las
  // memorias y romper el índice se olvidaría en la regeneración siguiente.
  let alterada = nueva.alterada || vieja.alterada || indice.alterada
    || (indice.existe && !indice.legible) || (indiceViejo.existe && !indiceViejo.legible);
  // las dos borradas con un índice que recuerda algo: alguien las borró (la primera vez no hay índice)
  if (!nueva.existe && !vieja.existe && deIndices.length) alterada = true;
  return { memoria: [...new Set([...enMemorias, ...deIndices])].sort(), alterada };
}

/** Escribe `texto` por un temporal y rename (nunca se ve un archivo a medias). */
function escribir(ruta, texto) {
  const tmp = ruta + '.tmp';
  fs.writeFileSync(tmp, texto); fs.renameSync(tmp, ruta);
}

/**
 * Borra la memoria y el índice de antes del renombre, una vez que lo suyo ya está en la memoria nueva (`memoria`).
 * Sin la puerta, cada uno se borra sólo si se lee, su huella cierra (la memoria) y cada servidor suyo está en la nueva:
 * si no, queda, y la alteración sigue a la vista. Con la puerta (`todo`), la persona aprobó en el cuadro y lo legible
 * ya se sumó al construir: se borran los dos, también lo que se bajó a propósito, para que no vuelva.
 */
function retirarViejos(home, memoria, todo) {
  const enLaNueva = new Set(memoria);
  const vieja = leerUnaMemoria(rutaMemoriaVieja(home));
  if (vieja.existe && (todo || (!vieja.alterada && vieja.hosts.every((h) => enLaNueva.has(h))))) {
    try { fs.unlinkSync(rutaMemoriaVieja(home)); } catch { /* sigue ahí: la próxima regeneración lo vuelve a intentar */ }
  }
  const indiceViejo = leerUnIndice(rutaIndiceVieja(home));
  if (indiceViejo.existe && (todo || (indiceViejo.legible && indiceViejo.hosts.every((h) => enLaNueva.has(h))))) {
    try { fs.unlinkSync(rutaIndiceVieja(home)); } catch { /* sigue ahí: la próxima regeneración lo vuelve a intentar */ }
  }
}

function guardar(indice, home, opts = {}) {
  const dir = dirDatos(home);
  fs.mkdirSync(dir, { recursive: true });
  escribir(rutaIndice(home), JSON.stringify(indice, null, 2));
  // 🔴 Una memoria alterada NO se vuelve a sellar sola. Antes, la misma lectura que detectaba el
  // toqueteo reescribía el archivo con una huella nueva, y a la lectura siguiente ya no figuraba nada
  // (revisores del Step 5, 2026-09-15, probado). La alteración queda a la vista hasta que una persona
  // la resuelve por la puerta (`tycon-prod-sql --reclassify`, o `--verify` si sólo se tocó lo de antes), que pasa por
  // el cuadro de aprobación. Mientras tanto, lo de antes tampoco se borra.
  if (indice.memoria_alterada && !opts.resellar) return indice;
  const mem = { produccion: indice.memoria };
  mem.huella = huellaDe({ produccion: indice.memoria });
  escribir(rutaMemoria(home), JSON.stringify(mem, null, 2));
  // lo viejo se borra sólo con la memoria nueva ya escrita: un corte en el medio deja lo viejo, nunca un hueco
  retirarViejos(home, indice.memoria, Boolean(opts.resellar));
  return indice;
}

/**
 * Lo que hace `tycon-prod-sql --verify` con la memoria: si la alteración viene sólo de lo de antes del renombre (la
 * memoria nueva se lee y su huella cierra), suma lo legible, sella la nueva y borra lo de antes. Sumar nunca baja un
 * servidor. Si la memoria nueva está tocada o falta, no la sella: eso lo decide una persona con `--reclassify`.
 * Devuelve { resuelto, sellado, motivo? }: `sellado` dice si hubo que sellar y borrar lo de antes.
 */
function resolverViejos(opts = {}) {
  const home = opts.home || os.homedir();
  // «se borró» y «sana» se dicen mirando que lo de antes ya no esté, no porque se intentó borrarlo
  const quedanViejos = () => [rutaMemoriaVieja(home), rutaIndiceVieja(home)].filter((r) => { try { fs.lstatSync(r); return true; } catch { return false; } });
  const noPudo = (quedan, sellado) => ({ resuelto: false, sellado, motivo: `${sellado ? 'sellé la memoria nueva pero ' : ''}no pude borrar lo de antes del renombre (${quedan.map((r) => path.basename(r)).join(', ')}): borralo a mano y volvé a verificar` });
  const i = construir({ home, raiz: opts.raiz });
  if (!i.memoria_alterada) {
    guardar(i, home);
    const quedan = quedanViejos();
    return quedan.length ? noPudo(quedan, false) : { resuelto: true, sellado: false };
  }
  const nueva = leerUnaMemoria(rutaMemoria(home));
  if (!nueva.existe || nueva.alterada) {
    return { resuelto: false, sellado: false, motivo: 'la memoria de producción está tocada o falta: revisala y resolvela con tycon-prod-sql --reclassify <host>' };
  }
  i.memoria_alterada = false;
  i.huella = huellaDe({ ...i, huella: undefined });
  guardar(i, home, { resellar: true });
  const quedan = quedanViejos();
  return quedan.length ? noPudo(quedan, true) : { resuelto: true, sellado: true };
}

const VIGENCIA_MS = 60 * 1000;   // el hook regenera a lo sumo una vez por minuto (AC 2)

/** El índice utilizable: el guardado si está fresco y su huella cierra; si no, se reconstruye. */
function leer(opts = {}) {
  const home = opts.home || os.homedir();
  if (!opts.forzar) {
    try {
      // sólo el nuevo: el de antes del renombre no es un índice, es una memoria por pasar (se suma al construir)
      const doc = JSON.parse(fs.readFileSync(rutaIndice(home), 'utf8'));
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
module.exports = { construir, leer, guardar, resolverViejos, clasificar, normalizar, esLocal, huellaDe, rutaIndice, rutaMemoria, rutaIndiceVieja, rutaMemoriaVieja, reposBajo, CATALOGO, CATALOGO_VIEJO };
