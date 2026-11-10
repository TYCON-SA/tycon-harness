'use strict';
/**
 * El guardado ajeno a un camino corto que espera sus revisores (la marca de riesgo alto sin las dos constancias). Un
 * commit o un push que el carril no reconoce como suyo frena como siempre, pero si la persona puede verlo entero, el
 * freno anota el pedido en el carril y dice el comando que pide su click (`marker.js adhoc allow-foreign-save`). El
 * click deja pasar ese comando una vez, en esa carpeta, con el repo como estaba: el permiso queda atado a una huella y
 * se reclama con un `rename`, así que de dos copias a la vez pasa una.
 *
 * Lo que la persona no puede ver entero, o lo que puede tocar la rama del carril, no se ofrece al click y frena como
 * siempre (`motivoParaNoOfrecer`). Leer el comando sirve para negar, nunca para dejar pasar.
 *
 * La configuración de git que corre programas: la del repo (`.git/config` y sus `include`), la de `-c` y la del
 * entorno no se ofrecen; la global y la del sistema se muestran en el cuadro y entran en la huella.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const LARGO_MAXIMO = 160;
const VIGENCIA_MS = 30 * 60 * 1000;
const EN_EL_CUADRO = 5;
// el renglón más largo que entra entero en el cuadro del click
const LARGO_DE_RENGLON = 600;
// lo que no se ve en el cuadro: los controles (también el salto de línea), los de formato (dirección, ancho cero), los
// separadores de renglón y de párrafo, los que se ignoran al mostrar y el braille en blanco. Es la misma clase que usa
// el cuadro de las firmas (`signature-sources`, CLASE_QUE_NO_SE_VE), copiada porque ese módulo carga éste. Además, los
// espacios que no se distinguen del común (el duro, el ideográfico…): un nombre con uno se ve igual que otro
const INVISIBLES = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u{2800}]|[^\P{Zs} ]/u;
// un prefijo de entorno de git, también con `env` o `export` delante
const ENTORNO_DE_GIT = /(?:^|[\s;&|()`])(?:export\s+)?GIT_[A-Za-z0-9_]*=/;
// las claves de la configuración que corren un programa al guardar o al empujar
const CORREN = [/^core\.(fsmonitor|sshcommand|pager|editor|askpass|gitproxy|hookspath)$/, /^filter\./, /^diff\..+\.(textconv|command)$/,
  /^diff\.external$/, /^merge\..+\.driver$/, /^credential\.(.+\.)?helper$/, /^gpg\./,
  /^remote\..+\.(uploadpack|receivepack|vcs)$/, /^sequence\.editor$/, /^pager\./, /^include(if)?\./, /^trailer\./,
  /^core\.alternaterefscommand$/, /^uploadpack\./];
const corre = (clave, valor) => CORREN.some((re) => re.test(clave)) || (/^alias\./.test(clave) && /^\s*!/.test(String(valor)));
// los alcances que son de la máquina (se muestran) y no del repo, de `-c` o del entorno (se niegan). `unknown` es el
// archivo del sistema que trae Xcode
const DE_LA_MAQUINA = new Set(['global', 'system', 'unknown']);
// los hooks que git corre por nombre
const HOOKS = new Set(['applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit', 'prepare-commit-msg',
  'commit-msg', 'post-commit', 'pre-rebase', 'post-checkout', 'post-merge', 'pre-push', 'post-rewrite', 'reference-transaction',
  'push-to-checkout', 'pre-auto-gc', 'sendemail-validate', 'fsmonitor-watchman', 'post-index-change']);
// las opciones de un push que pueden tocar otra rama o borrar
const PUSH_QUE_NO = /^(-f|--force|--force-with-lease(=.*)?|--force-if-includes|--all|--mirror|--branches|--delete|-d|--tags|--prune|--follow-tags|--recurse-submodules(=.*)?|-[A-Za-z]*[fd][A-Za-z]*)$/;
// las mismas, largas, para reconocerlas abreviadas
const PUSH_LARGAS_QUE_NO = ['--force', '--force-with-lease', '--force-if-includes', '--all', '--mirror', '--branches', '--delete', '--tags',
  '--prune', '--follow-tags', '--recurse-submodules', '--repo'];
/**
 * ¿`w` es una de `largas` escrita entera o abreviada, con o sin `=valor`? git acepta cualquier prefijo que no sea ambiguo
 * entre las opciones del subcomando, desde una letra (`--m` es `--mirror` en un push): se compara desde una letra, y un
 * prefijo que git rechazaría por ambiguo se niega igual, que es cerrar en falla.
 */
function abreviaDe(w, largas) {
  const m = /^(--[a-z][a-z-]*)(=|$)/.exec(String(w));
  return !!m && largas.some((l) => l.startsWith(m[1]));
}
// lo único que puede ir en un comando que se ofrece al click: git que guarda o que mira, y moverse de carpeta
const GIT_QUE_SE_OFRECE = new Set(['commit', 'push', 'add', 'status', 'diff', 'log', 'show', 'rev-parse']);
const SOLO_SE_MUEVEN = new Set(['cd', 'pushd', 'popd']);
// las opciones de un commit que llevan su valor aparte (lo que sigue no es una ruta)
const COMMIT_CON_VALOR = new Set(['-m', '-F', '-C', '-c', '-t', '--author', '--date', '--cleanup', '--template', '--fixup', '--squash',
  '--trailer', '--message', '--file', '--reuse-message', '--reedit-message', '--pathspec-from-file']);

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

function git(dir, args, { binario = false, sale = [0] } = {}) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: binario ? 'buffer' : 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
  if (r.error || !sale.includes(r.status)) throw new Error(`git ${args.filter((x) => !x.startsWith('-')).slice(0, 2).join(' ')} no contestó en ${dir}`);
  return { salida: binario ? r.stdout : String(r.stdout), codigo: r.status };
}

/**
 * La URL de un remoto, igual por ssh o https: sin usuario ni `.git` final, y entera en minúsculas (los servidores de
 * repos no distinguen la ruta; comparar de más sólo niega de más). Una ruta, real.
 */
function normalizarUrl(url, base) {
  const u = String(url || '').trim();
  const m = servidorYRuta(u);
  if (m) {
    const host = m.host.toLowerCase();
    const ruta = m.ruta.replace(/\/+$/, '').replace(/\.git$/i, '').replace(/^\/+/, '').toLowerCase();
    return deAzure(host, ruta) || `${host}/${ruta}`;
  }
  // una ruta: la del repo y la de su carpeta `.git` son el mismo repo
  const sinGit = (p) => p.replace(/\/+$/, '').replace(/\/\.git$/i, '').replace(/\.git$/i, '');
  try { return sinGit(fs.realpathSync(path.resolve(base || process.cwd(), u.replace(/^file:\/\//, '')))); } catch (_) { return sinGit(u); }
}

/**
 * El servidor y la ruta de una URL de un remoto (`esquema://[usuario@]servidor[:puerto]/ruta` o la forma scp
 * `[usuario@]servidor:ruta`), o null si es una ruta de esta máquina: una ruta, `file://` o una letra de unidad.
 */
function servidorYRuta(u) {
  if (/^file:/i.test(u)) return null;
  let m = /^(?:[a-z+]+:\/\/)(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.*)$/i.exec(u);
  if (!m) m = /^(?:[^@/]+@)?([^/:]+):(?!\/\/)(.*)$/.exec(u);
  if (!m || /^[A-Za-z]$/.test(m[1])) return null;
  return { host: m[1], ruta: m[2] };
}

/** ¿La URL es un repo de esta máquina? Al empujarle, sus hooks del lado que recibe corren acá. */
const esRutaLocal = (url) => !servidorYRuta(String(url || '').trim());

/**
 * Azure DevOps nombra el mismo repo de varias formas: la https (`dev.azure.com/org/proy/_git/repo`), la vieja
 * (`org.visualstudio.com/proy/_git/repo`, también con `DefaultCollection/`), la ssh (`ssh.dev.azure.com:v3/org/proy/repo`)
 * y la ssh vieja (`vs-ssh.visualstudio.com:v3/org/proy/repo`); sin proyecto (`_git/repo`), el proyecto se llama como el
 * repo. Todas dan `dev.azure.com/org/proy/_git/repo`; lo que no es de Azure, null. Recibe el servidor y la ruta en minúsculas.
 */
function deAzure(host, ruta) {
  const forma = (org, proy, repo) => `dev.azure.com/${org}/${proy}/_git/${repo}`;
  if (host === 'ssh.dev.azure.com' || host === 'vs-ssh.visualstudio.com') {
    const m = /^v3\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(ruta);
    return m ? forma(m[1], m[2], m[3]) : null;
  }
  const vieja = /^([^.]+)\.visualstudio\.com$/.exec(host);
  if (host !== 'dev.azure.com' && !vieja) return null;
  const partes = ruta.split('/');
  const org = vieja ? vieja[1] : partes.shift();
  if (partes[0] === 'defaultcollection') partes.shift();
  if (partes.length === 3 && partes[1] === '_git') return forma(org, partes[0], partes[2]);
  if (partes.length === 2 && partes[0] === '_git') return forma(org, partes[1], partes[1]);
  return null;
}

/**
 * Las URLs de cada remoto de cada repo del carril (las de traer y las de empujar), normalizadas. Si git no las da, tira:
 * sin ellas no se puede negar el push a un remoto del carril, y eso no se ofrece.
 */
function urlsDelCarril(repos) {
  const out = new Set();
  for (const r of repos) {
    const nombres = git(r, ['remote']).salida.split('\n').map((s) => s.trim()).filter(Boolean);
    for (const n of nombres) {
      for (const extra of [[], ['--push']]) {
        for (const u of git(r, ['remote', 'get-url', '--all', ...extra, n]).salida.split('\n').filter(Boolean)) out.add(normalizarUrl(u, r));
      }
    }
    out.add(normalizarUrl(r, r));
  }
  return out;
}

/** Los hooks que corren al guardar en el repo: `{ hooks: [{ nombre, huella }], motivo }`. */
function hooksDelRepo(repo) {
  const hp = git(repo, ['config', '--get', 'core.hooksPath'], { sale: [0, 1] });
  if (hp.codigo === 1) {
    const dir = git(repo, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']).salida.trim();
    // cualquier cosa que no sea un ejemplo cuenta, también un enlace roto; una carpeta que no se lee no es «sin hooks»
    let hay = [];
    try { hay = fs.readdirSync(dir).filter((f) => !f.endsWith('.sample')); } catch (e) {
      if (e.code !== 'ENOENT') return { motivo: `no pude leer los hooks de ${dir} (${e.code || e.message})` };
    }
    if (hay.length) return { motivo: `un hook que no es del repo (${path.join(dir, hay[0])})` };
    return { hooks: [] };
  }
  const valor = hp.salida.trim().replace(/^~(?=[\\/])/, require('os').homedir());
  const dir = path.resolve(repo, valor);
  // la carpeta de hooks de la configuración de la máquina (la que instala el arnés en cada una): como el resto de esa
  // configuración (decisión 7 bis), se muestra y su contenido entra en la huella
  const alcance = git(repo, ['config', '--show-scope', '--get', 'core.hooksPath'], { sale: [0, 1] }).salida.split('\t')[0].trim();
  if (DE_LA_MAQUINA.has(alcance)) return { hooks: hooksDe(dir), carpeta: `${valor}, de la configuración de la máquina` };
  const rel = path.relative(repo, dir);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { motivo: `core.hooksPath apunta afuera del repo (${valor})` };
  if (!git(repo, ['ls-files', '-z', '--', rel]).salida) return { motivo: `core.hooksPath apunta a una carpeta que el repo no versiona (${rel})` };
  if (git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching', '--', rel]).salida) {
    return { motivo: `los hooks de ${rel} tienen cambios o archivos nuevos contra HEAD` };
  }
  return { hooks: hooksDe(dir), carpeta: `${rel}, versionados, sin cambios contra HEAD` };
}

// los hooks que git corre de una carpeta: por su nombre, ejecutables (en Windows, todos), con la huella de su contenido.
// Una carpeta que no existe no tiene hooks; una que no se lee, o un hook que no se lee, tira (y no se ofrece el click)
function hooksDe(dir) {
  const hooks = [];
  let nombres = [];
  try { nombres = fs.readdirSync(dir).sort(); } catch (e) { if (e.code !== 'ENOENT') throw new Error(`no pude leer los hooks de ${dir} (${e.code || e.message})`); }
  for (const f of nombres) {
    const p = path.join(dir, f);
    if (!HOOKS.has(f) || !fs.statSync(p).isFile()) continue;
    if (process.platform !== 'win32' && !(fs.statSync(p).mode & 0o111)) continue;
    hooks.push({ nombre: f, huella: sha(fs.readFileSync(p)) });
  }
  return hooks;
}

/** La configuración efectiva que corre programas: `{ mostrar: [{ clave, valor, alcance }], motivo }`. */
function configuracionQueCorre(repo) {
  const crudo = git(repo, ['config', '--list', '--show-scope', '-z']).salida.split('\0');
  const mostrar = [];
  for (let k = 0; k + 1 < crudo.length; k += 2) {
    const alcance = crudo[k];
    const [clave, ...v] = crudo[k + 1].split('\n');
    const valor = v.join('\n');
    const c = clave.toLowerCase();
    if (!corre(c, valor) || c === 'core.hookspath') continue;
    if (!DE_LA_MAQUINA.has(alcance)) return { motivo: `la clave ${clave} de la configuración ${alcance === 'command' ? 'del comando o del entorno' : 'del repo'} corre un programa` };
    mostrar.push({ clave, valor, alcance: alcance === 'unknown' ? 'system' : alcance });
  }
  return { mostrar };
}

/**
 * ¿Por qué este guardado no se ofrece al click? El motivo, o null. `gits`: cada `git` del comando, leído como el freno
 * (`save-brake.gitsDelShell`). `repos`: las raíces de los guardados. `urls`: las del carril.
 */
function motivoParaNoOfrecer({ command, cs, dudas, gits, repos, rutaPropia, urls, raiz }) {
  const texto = String(command || '');
  if (INVISIBLES.test(texto)) return 'el comando tiene un salto de línea o un carácter que no se ve';
  if (texto.length > LARGO_MAXIMO) return `el comando tiene más de ${LARGO_MAXIMO} caracteres y no entra entero en el cuadro`;
  if (dudas.length || cs.some((c) => c.opaco)) return 'el comando no se lee con certeza';
  if (cs.some((c) => c.tipo === 'pr')) return 'abre o mergea un pedido';
  if (rutaPropia) return 'trae su propia ruta de riesgo alto';
  if (repos.length !== 1) return 'guarda en más de un repo';
  if (cs.some((c) => c.incierto)) return 'no se sabe a dónde empuja (el comando cambia antes la rama, la configuración o el destino)';
  if (ENTORNO_DE_GIT.test(texto)) return 'trae un prefijo de entorno de git';
  for (const g of gits) {
    // lo que no es un git que guarda o que mira puede guardar por su cuenta (`git subtree push`, un guion): no se ofrece
    if (g.otro !== undefined && !SOLO_SE_MUEVEN.has(g.otro)) return `corre otro programa además de git (${g.otro})`;
    if (g.otro !== undefined) continue;
    if (!GIT_QUE_SE_OFRECE.has(g.sub)) return `corre git ${g.sub || '(sin subcomando)'}, que no es un commit ni un push`;
    // un git que mira o prepara en otro repo también es «más de un repo»
    if (raiz && g.dirs.some((d) => { try { return raiz(d) !== repos[0]; } catch (_) { return true; } })) return 'toca más de un repo';
    const ps = g.ps;
    for (let k = 1; k < g.i; k++) {
      if (/^--config-env/.test(ps[k]) || /^--exec-path/.test(ps[k])) return `trae ${ps[k].split('=')[0]}`;
      if (ps[k] === '-c' || /^-c./.test(ps[k])) {
        const v = ps[k] === '-c' ? String(ps[k + 1] || '') : ps[k].slice(2);
        const [clave, ...resto] = v.split('=');
        if (corre(clave.toLowerCase(), resto.join('='))) return `trae -c ${clave}, que corre un programa`;
        // la URL que se muestra sale de la configuración del repo: un `-c` que cambia a dónde empuja no se ve ahí
        if (/^(url|remote|push|branch)\./i.test(clave)) return `trae -c ${clave}, que cambia a dónde empuja`;
      }
    }
    // git acepta una opción larga abreviada mientras no sea ambigua (`--receive`, `--forc`): se compara por prefijo
    const peligrosa = ps.find((w) => abreviaDe(w, ['--upload-pack', '--receive-pack', '--exec']));
    if (peligrosa) return `trae ${peligrosa.split('=')[0]}`;
    if (g.sub === 'commit' && g.resto.some((w) => abreviaDe(w, ['--amend']))) return 'reescribe un commit (--amend)';
    // `git add -f` suma lo ignorado, y lo ignorado no entra en la huella
    if (g.sub === 'add' && g.resto.some((w) => w === '-f' || /^-[A-Za-z]*f/.test(w) || abreviaDe(w, ['--force']))) return 'suma archivos ignorados (git add -f)';
    if (g.sub === 'push') {
      const f = g.resto.find((w) => PUSH_QUE_NO.test(w) || abreviaDe(w, PUSH_LARGAS_QUE_NO));
      if (f) return `empuja con ${f}`;
      const posicionales = g.resto.filter((w, k) => !w.startsWith('-') && !['-o', '--push-option', '--repo'].includes(g.resto[k - 1]));
      if (g.resto.some((w) => /^--repo/.test(w))) return 'empuja con --repo';
      if (posicionales.length > 2) return 'empuja más de un refspec';
      // `:rama` borra la rama remota y `+rama` la fuerza
      if (posicionales[1] && /^[:+]/.test(posicionales[1])) return `empuja ${posicionales[1]}, que borra o fuerza una rama`;
      // un refspec con comodín empuja más de una rama
      if (posicionales[1] && posicionales[1].includes('*')) return `empuja ${posicionales[1]}, que nombra más de una rama`;
      const remoto = posicionales[0];
      const dir = g.dirs[0];
      let nombres = [];
      try { nombres = git(dir, ['remote']).salida.split('\n').map((s) => s.trim()).filter(Boolean); } catch (_) { return 'no pude leer los remotos'; }
      if (remoto && !nombres.includes(remoto)) return `empuja a una ruta o una URL que no es un remoto con nombre (${remoto})`;
      // sin remoto escrito, git lo elige con `branch.<rama>.pushRemote` o `remote.pushDefault` antes que con el de la rama:
      // el destino que se mostraría no sería el real
      let elige;
      try { elige = destinoQueEligeGit(dir, remoto, posicionales[1]); } catch (e) { return `no pude leer a dónde empuja (${e.message})`; }
      if (elige) return elige;
      const efectivo = remoto || upstreamDe(dir);
      if (!efectivo) return 'empuja sin un remoto con nombre';
      // git empuja a todas las URLs de empuje del remoto (o a todas las de traer, si no tiene): se miran todas. Una URL
      // relativa la resuelve contra la raíz del repo, no contra la carpeta del comando
      let todas;
      let raizDelRepo;
      try {
        todas = git(dir, ['remote', 'get-url', '--all', '--push', efectivo]).salida.split('\n').map((s) => s.trim()).filter(Boolean);
        raizDelRepo = git(dir, ['rev-parse', '--show-toplevel']).salida.trim();
      } catch (_) { return `no pude leer las URLs de ${efectivo}`; }
      if (!todas.length || !raizDelRepo) return `no pude leer las URLs de ${efectivo}`;
      const delCarril = todas.find((u) => urls.has(normalizarUrl(u, raizDelRepo)));
      if (delCarril) return `empuja a la URL de un remoto del carril (${delCarril})`;
      // un repo de esta máquina corre sus hooks del lado que recibe (pre-receive, update, post-receive…) acá, al empujar,
      // y ni el cuadro ni la huella los ven
      const local = todas.find(esRutaLocal);
      if (local) return `empuja a un repo de esta máquina (${local}): sus hooks del lado que recibe corren acá y no se ven`;
      // `transporte::dirección` (ext::, fd:: o un ayudante git-remote-<transporte>) corre un programa para empujar
      const ayudante = todas.find((u) => /^[A-Za-z0-9][A-Za-z0-9+.-]*::/.test(u));
      if (ayudante) return `empuja con un transporte que corre un programa (${ayudante})`;
    }
  }
  return null;
}

/**
 * ¿La configuración decide un destino que el comando no dice? El motivo, o null. Sin remoto escrito: `pushRemote` de la
 * rama o `remote.pushDefault`. Sin refspec: `remote.<n>.push` del remoto, o `push.default=matching` (empuja todas las
 * ramas con el mismo nombre), o `push.default=upstream` con la rama de seguimiento de otro nombre. Y la configuración con
 * el mismo efecto que una opción que ya se niega: `remote.<n>.mirror` (`--mirror`), `push.recurseSubmodules` y
 * `submodule.recurse` (`--recurse-submodules`) y `push.followTags` (`--follow-tags`).
 */
function destinoQueEligeGit(dir, remoto, refspec) {
  // null si la clave no está; '' si está sin valor (en un booleano, eso es «verdadero»)
  const leer = (clave) => { const r = git(dir, ['config', '--get', clave], { sale: [0, 1] }); return r.codigo === 1 ? null : r.salida.trim(); };
  // git normaliza el booleano (`yes`, `on`, `1`, sin valor); uno que no lo es tira y no se ofrece
  const si = (clave) => git(dir, ['config', '--type=bool', '--get', clave], { sale: [0, 1] }).salida.trim() === 'true';
  const rama = git(dir, ['symbolic-ref', '--short', '-q', 'HEAD'], { sale: [0, 1] }).salida.trim();
  if (!remoto) {
    if (rama && leer(`branch.${rama}.pushRemote`)) return `el remoto del push lo elige branch.${rama}.pushRemote, que el comando no dice`;
    if (leer('remote.pushDefault')) return 'el remoto del push lo elige remote.pushDefault, que el comando no dice';
  }
  const efectivo = remoto || upstreamDe(dir);
  if (efectivo && si(`remote.${efectivo}.mirror`)) return `remote.${efectivo}.mirror empuja todas las referencias y borra las que faltan, como --mirror`;
  if (!refspec) {
    if (efectivo && leer(`remote.${efectivo}.push`)) return `las ramas que empuja las elige remote.${efectivo}.push, que el comando no dice`;
    const porDefecto = String(leer('push.default') || '').toLowerCase();
    if (porDefecto === 'matching') return 'push.default=matching empuja todas las ramas con el mismo nombre';
    // `upstream` (o su nombre viejo, `tracking`) empuja a la rama de seguimiento, que puede llamarse de otra forma
    if (['upstream', 'tracking'].includes(porDefecto) && rama) {
      const sigue = leer(`branch.${rama}.merge`);
      if (sigue && sigue !== `refs/heads/${rama}`) return `push.default=${porDefecto} empuja a ${sigue}, que el comando no dice`;
    }
  }
  const submodulos = leer('push.recurseSubmodules');
  if (submodulos !== null ? !/^(no|false|off|0)$/i.test(submodulos) : si('submodule.recurse')) {
    return 'la configuración empuja también los submódulos (push.recurseSubmodules o submodule.recurse), como --recurse-submodules';
  }
  if (si('push.followTags')) return 'push.followTags suma etiquetas al push';
  return null;
}

function upstreamDe(dir) {
  try {
    const rama = git(dir, ['symbolic-ref', '--short', '-q', 'HEAD'], { sale: [0, 1] }).salida.trim();
    if (!rama) return null;
    const r = git(dir, ['config', '--get', `branch.${rama}.remote`], { sale: [0, 1] }).salida.trim();
    return r || (git(dir, ['remote']).salida.split('\n').map((s) => s.trim()).filter(Boolean).length === 1 ? git(dir, ['remote']).salida.trim() : null);
  } catch (_) { return null; }
}

/** Lo que guarda cada `git`: en un commit, los archivos; en un push, el remoto, la rama y los commits que suben. */
function loQueGuarda(gits, repo, escritos) {
  const partes = [];
  const sumaAntes = escritos || gits.some((g) => g.sub && !['commit', 'push', 'status', 'diff', 'log', 'show', 'fetch', 'rev-parse'].includes(g.sub));
  for (const g of gits) {
    if (g.sub === 'commit') {
      let puedeSumar = sumaAntes;
      for (let k = 0; k < g.resto.length; k++) {
        const w = g.resto[k];
        if (w === '--') { if (g.resto.length > k + 1) puedeSumar = true; break; }
        // las rutas que nombra un archivo también se guardan
        if (/^--pathspec-from-file(=|$)/.test(w)) puedeSumar = true;
        if (COMMIT_CON_VALOR.has(w)) { k++; continue; }
        if (/^-[A-Za-z]*[aipo][A-Za-z]*$/.test(w) && !/^-[A-Za-z]*[mFCct]$/.test(w)) puedeSumar = true;
        // las largas, también abreviadas (`--al`, `--inter`, `--patc`): git las acepta mientras no sean ambiguas
        if (abreviaDe(w, ['--all', '--include', '--only', '--interactive', '--patch'])) puedeSumar = true;
        if (/^-[A-Za-z]*a/.test(w) || w === '--all') puedeSumar = true;
        if (!w.startsWith('-')) puedeSumar = true;
      }
      const lista = puedeSumar
        ? nombresDelEstado(git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).salida)
        : git(repo, ['diff', '--cached', '--name-only', '-z']).salida.split('\0').filter(Boolean);
      partes.push({ tipo: 'commit', archivos: lista, todos: puedeSumar });
    } else if (g.sub === 'push') {
      const pos = g.resto.filter((w, k) => !w.startsWith('-') && !['-o', '--push-option'].includes(g.resto[k - 1]));
      const remoto = pos[0] || upstreamDe(repo);
      const refspec = pos[1] || 'HEAD';
      const [origen, destinoEscrito] = refspec.includes(':') ? refspec.split(':') : [refspec, null];
      const actual = git(repo, ['symbolic-ref', '--short', '-q', 'HEAD'], { sale: [0, 1] }).salida.trim();
      const rama = (destinoEscrito || (origen === 'HEAD' ? actual : origen) || '').replace(/^refs\/heads\//, '');
      // todas las URLs a las que empuja, como las mira el chequeo
      let url = null;
      try { url = git(repo, ['remote', 'get-url', '--all', '--push', remoto]).salida.split('\n').map((s) => s.trim()).filter(Boolean).join(', ') || null; } catch (_) { url = null; }
      const remota = `refs/remotes/${remoto}/${rama}`;
      const tiene = git(repo, ['rev-parse', '-q', '--verify', remota], { sale: [0, 1] }).codigo === 0;
      const rango = tiene ? [`${remota}..${origen}`] : [origen, '--not', `--remotes=${remoto}`];
      const commits = git(repo, ['log', '--format=%h %s', ...rango, '--']).salida.split('\n').filter(Boolean);
      partes.push({ tipo: 'push', remoto, url, rama, commits, contra: tiene ? `${remoto}/${rama}` : null });
    }
  }
  return partes;
}

// los nombres de `git status --porcelain=v1 -z`. Un renombre o una copia trae después la ruta de origen, tanto en lo
// preparado (columna X) como en el árbol de trabajo (columna Y): la de origen también cambia (se borra), y se muestra
function nombresDelEstado(z) {
  const out = [];
  const ws = z.split('\0');
  for (let k = 0; k < ws.length; k++) {
    const w = ws[k];
    if (!w) continue;
    out.push(w.slice(3));
    if (/^(?:[RC].|.[RC])/.test(w) && ws[k + 1]) out.push(ws[++k]);
  }
  return out;
}

/**
 * El pedido de este guardado, con su huella: el comando, la carpeta real, el repo, la rama, el `HEAD`, el estado del repo,
 * los hooks y la configuración de la máquina que corre programas. `{ pedido }` o `{ motivo }` si no se ofrece.
 */
function armarPedido({ command, cwd, repo, gits, escritos }) {
  const hooks = hooksDelRepo(repo);
  if (hooks.motivo) return { motivo: hooks.motivo };
  const conf = configuracionQueCorre(repo);
  if (conf.motivo) return { motivo: conf.motivo };
  const rama = git(repo, ['symbolic-ref', '--short', '-q', 'HEAD'], { sale: [0, 1] }).salida.trim() || 'HEAD';
  const head = git(repo, ['rev-parse', '-q', '--verify', 'HEAD'], { sale: [0, 1] }).salida.trim() || null;
  const estado = git(repo, ['status', '--porcelain=v2', '-z', '--untracked-files=all']).salida;
  const preparado = git(repo, ['diff', '--cached', '--raw', '-z']).salida;
  // el contenido, no sólo los nombres: lo que cambió sin preparar y cada archivo sin seguir. Si después del click se
  // reescribe uno, `commit -a` o `git add` guardarían otra cosa que la que se vio
  const sinPreparar = sha(git(repo, ['diff', '--binary', '--no-ext-diff', '--no-textconv'], { binario: true }).salida);
  const sinSeguir = estado.split('\0').filter((x) => x.startsWith('? ')).map((x) => x.slice(2)).sort().map((rel) => {
    try { return `${rel}\0${sha(fs.readFileSync(path.join(repo, rel)))}`; } catch (e) { return `${rel}\0${e.code || 'ilegible'}`; }
  });
  let real = cwd;
  try { real = fs.realpathSync(cwd); } catch (_) { real = cwd; }
  const guarda = loQueGuarda(gits, repo, escritos);
  const huella = sha(JSON.stringify({ comando: command, cwd: real, repo, rama, head, estado, preparado, sinPreparar, sinSeguir, hooks: hooks.hooks, conf: conf.mostrar, guarda })).slice(0, 16);
  const pedido = { comando: command, cwd: real, repo, rama, head, huella, guarda, hooks: hooks.hooks.map((h) => h.nombre), hooksCarpeta: hooks.carpeta || null,
    configuracion: conf.mostrar, at: new Date().toISOString() };
  const motivo = motivoDelPedido(pedido);
  return motivo ? { motivo } : { pedido };
}

/**
 * Lo que el cuadro va a mostrar tiene que verse entero y tal como es: un nombre de archivo, un asunto de commit, una URL o
 * un valor de configuración con un carácter que no se ve (o una secuencia de la terminal) puede hacer que el cuadro diga
 * otra cosa, y un renglón demasiado largo no entra en la pregunta. En los dos casos no se ofrece el click. Un motivo o null.
 */
function motivoDelPedido(pedido) {
  const lineas = lineasDe(pedido, { todo: true });
  if (lineas.some((l) => INVISIBLES.test(l))) return 'lo que guarda trae un carácter que no se ve (en un nombre de archivo, un commit, una URL, la rama o la configuración)';
  if (lineas.some((l) => l.length > LARGO_DE_RENGLON)) return `lo que guarda no entra entero en el cuadro (un renglón de más de ${LARGO_DE_RENGLON} letras)`;
  return null;
}

const permisoPath = (dir, sid) => require('./story-gate-io.js').adhocPath(dir, sid).replace(/\.json$/, '.guardado-ajeno.permiso');

/** ¿Hay un permiso para este pedido? Lo reclama (un `rename`: sólo una copia lo logra) y lo borra. */
function reclamarPermiso(dir, sid, pedido, ahora = Date.now()) {
  const f = permisoPath(dir, sid);
  let p;
  try { p = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return false; }
  if (!p || p.huella !== pedido.huella || p.comando !== pedido.comando || p.cwd !== pedido.cwd || p.repo !== pedido.repo) return false;
  // sólo lo que anota el click o la terminal de una persona, y nunca con una hora que todavía no llegó
  if (!['click', 'terminal'].includes(p.via)) return false;
  const edad = ahora - Date.parse(p.at);
  if (!(edad >= -60 * 1000 && edad <= VIGENCIA_MS)) return false;
  const usado = `${f}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.usado`;
  try { fs.renameSync(f, usado); } catch (_) { return false; }
  try { fs.unlinkSync(usado); } catch (_) { /* ya reclamado */ }
  return p;
}

function borrarPermiso(dir, sid) {
  try { fs.unlinkSync(permisoPath(dir, sid)); } catch (_) { /* no había */ }
}

/** Las líneas de lo que guarda, para la terminal (`todo`) o para el cuadro (hasta cinco nombres y cuántos más). */
function lineasDe(pedido, { todo = false } = {}) {
  const corta = (xs) => (todo || xs.length <= EN_EL_CUADRO ? xs.join(', ') : `${xs.slice(0, EN_EL_CUADRO).join(', ')} y ${xs.length - EN_EL_CUADRO} más`);
  const out = [`Comando: ${pedido.comando}`, `En: ${pedido.repo} · rama ${pedido.rama}`];
  for (const g of pedido.guarda || []) {
    if (g.tipo === 'commit') {
      out.push(`Commit de ${g.archivos.length} archivo(s)${g.todos ? ' (todos los que tienen cambios: el comando puede sumar más)' : ''}: ${corta(g.archivos) || 'ninguno'}`);
    } else {
      const cuantos = `${g.commits.length} commit(s) ${g.contra ? `que ${g.contra} no tiene` : `que ${g.remoto} no tiene`}, según la última copia local`;
      out.push(`Push a ${g.remoto}${g.url ? ` (${g.url})` : ''}, rama ${g.rama}: ${cuantos}: ${corta(g.commits) || 'ninguno'}`);
    }
  }
  out.push(pedido.hooks && pedido.hooks.length
    ? `Hooks que corren al guardar: ${pedido.hooks.join(', ')} (de ${pedido.hooksCarpeta})`
    : 'Hooks que corren al guardar: ninguno');
  // un renglón por clave: la configuración de una máquina común (git-lfs, los ayudantes de credenciales) junta pasa las
  // 600 letras de un renglón, y el click no se ofrecería nunca en esa máquina
  for (const c of pedido.configuracion || []) out.push(`Configuración de la máquina que corre programas: ${c.clave}=${c.valor} (${c.alcance})`);
  return out;
}

/** El texto del freno con el pedido anotado, en los dos perfiles. */
function textoDelPedido({ harness, motivoDelCarril, archivo, regla, pedido, marker }) {
  const carril = `«${String(motivoDelCarril || '').slice(0, 120)}»`;
  return (harness ? [
    `🔒 GUARDAR: esto no es del camino corto ${carril}, pero ese carril espera sus revisores y el pase por una ruta de riesgo alto (${archivo}, regla: ${regla}), y mientras tanto no guarda nada.`,
    `  Lo que guarda: ${pedido.comando} en ${pedido.repo} (rama ${pedido.rama}).`,
    '  Si es ajeno al carril, lo deja pasar una vez el click de una persona, con lo que guarda a la vista, en esta pestaña o en la',
    '  de la coordinadora (o su terminal). No vale por delegación ni por un «aprobado» escrito. Pedilo con:',
    `    node ${marker} adhoc allow-foreign-save`,
    '  Después repetí el mismo comando, sin cambiar nada. Si no, corré los revisores y el pase del carril, con sus dos constancias.',
  ] : [
    `🔒 GUARDAR: esto no es del camino corto ${carril}, pero ese carril espera sus revisores y el pase por una ruta de riesgo alto (${archivo}, regla: ${regla}), y mientras tanto no guarda nada.`,
    `  Lo que guarda: ${pedido.comando} en ${pedido.repo} (rama ${pedido.rama}).`,
    '  Si es ajeno al carril, lo dejás pasar vos una vez con un click, con lo que guarda a la vista (o desde tu terminal):',
    `    node ${marker} adhoc allow-foreign-save`,
    '  Después repetí el mismo comando, sin cambiar nada. Si no, corré los revisores y el pase del carril.',
  ]).join('\n');
}

module.exports = { LARGO_MAXIMO, VIGENCIA_MS, normalizarUrl, urlsDelCarril, hooksDelRepo, configuracionQueCorre, motivoParaNoOfrecer, loQueGuarda,
  armarPedido, permisoPath, reclamarPermiso, borrarPermiso, lineasDe, textoDelPedido };
