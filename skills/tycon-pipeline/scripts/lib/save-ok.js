'use strict';
/**
 * save-ok.js — el ok de guardar una story (commit, push y los pedidos): la firma `save` y su constancia (@story-8.143).
 *
 * `marker.js approve-save` lo firma y deja `saveOk` en el marcador de la corrida; `marker.js save-check` dice si
 * sigue valiendo. Acá vive todo lo que eso mide, sin depender de marker.js:
 *   · reposDeLaCorrida  el repo de la story más todo repo con cambios reales (los de `fileEvents` y los hermanos);
 *   · huellas           por repo, la rama, la base (`origin/main`) y el árbol que produciría su cambio, armado con un
 *                       índice temporal: entran los archivos sin seguimiento y el índice de la persona no se toca;
 *   · vigente           si cada repo sigue en la rama y con el árbol de la huella (o ya commiteado);
 *   · antesDeFirmar     por delegación, si la corrida terminó limpia, si el cambio no toca nada sensible y el aviso
 *                       al dueño; corre con el pedido de la ventana sin gastar (owner-window.js `exigir({ antes })`);
 *   · constancia        el `saveOk` que se escribe después de la firma.
 *
 * Todo lo de afuera (los canales, el envío del aviso, los hallazgos, las firmas de la corrida) entra por parámetro.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.join(__dirname, '..', '..', '..', '..');
const catalogo = () => require(path.join(RAIZ, 'scripts', 'lib', 'signatures.js'));

const BASE = 'origin/main';
// la evidencia que escribe el pipeline (hallazgos, aprobaciones, la ronda de revisores): no es código de la story. Sólo
// sus datos y sus informes; cualquier otro archivo bajo `.advisors/` es código, y además sensible (ver `sensibles`)
const EVIDENCIA = '.advisors';
const PATRONES_EVIDENCIA = [`${EVIDENCIA}/**/*.json`, `${EVIDENCIA}/**/*.jsonl`, `${EVIDENCIA}/**/*.md`];
const esEvidencia = (rel) => rel.startsWith(`${EVIDENCIA}/`) && /\.(json|jsonl|md)$/i.test(rel);
// las firmas que eximen algo en la corrida: con una de ellas la story no terminó limpia
const EXIMEN = ['critical-waiver', 'runtime-waiver', 'escape:force-manual'];

function git(repo, args, env) {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: env ? { ...process.env, ...env } : process.env, maxBuffer: 64 * 1024 * 1024 });
  // `crudo` sin recortar: en `status --porcelain` el primer espacio es parte de la columna del estado
  return { ok: r.status === 0, out: String(r.stdout || '').trim(), crudo: String(r.stdout || ''), err: String(r.stderr || '').trim() };
}
const real = (p) => { try { return fs.realpathSync(p); } catch (_) { return path.resolve(p); } };

/**
 * La raíz del repo de git que contiene `p` (un archivo que puede no existir, o una carpeta), o null si no está en
 * ningún repo. Cualquier otro fallo de git tira: no poder preguntar no es «no hay repo».
 */
function raizDe(p) {
  let d = path.resolve(String(p));
  for (;;) {
    try { if (fs.statSync(d).isDirectory()) break; } catch (_) { /* subo */ }
    const arriba = path.dirname(d);
    if (arriba === d) return null;
    d = arriba;
  }
  const r = git(d, ['rev-parse', '--show-toplevel']);
  if (r.ok && r.out) return real(r.out);
  if (/not a git repository/i.test(r.err)) return null;
  throw new Error(`no pude preguntarle a git por ${d} (${r.err || 'sin salida'})`);
}

/** ¿El repo tiene cambios: algo en `git status`, o commits propios contra su base? */
function tieneCambios(repo) {
  const st = git(repo, ['status', '--porcelain']);
  if (!st.ok || st.out) return true;   // «no pude mirar» cuenta como cambio: el repo entra y su huella dice qué hay
  const d = git(repo, ['diff', '--name-only', `${BASE}...HEAD`]);
  return !d.ok || !!d.out;
}

/**
 * Las rutas absolutas (o desde `~/`) que la story declara en `files_to_modify` y `files_to_create`: nombran archivos de
 * otro repo. Lee la lista con o sin sangría, y la lista en línea (`[a, b]`); una ruta entre comillas puede tener
 * espacios. Una story que no se puede leer, o que no está en el disco, tira: sin ella no se sabe qué repos declara.
 */
function rutasDeclaradas(storyPath) {
  if (!storyPath) return [];
  const texto = fs.readFileSync(storyPath, 'utf8');
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(texto);
  if (!fm) return [];
  const crudas = [];
  let enLista = false;
  for (const l of fm[1].split(/\r?\n/)) {
    const clave = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(l);
    if (clave) {
      enLista = /^files_to_(modify|create)$/.test(clave[1]);
      const enLinea = enLista && /^\[(.*)\]/.exec(clave[2].trim());
      if (enLinea) crudas.push(...enLinea[1].split(','));
      continue;
    }
    const item = enLista && /^\s*-\s+(.*)$/.exec(l);
    if (item) crudas.push(item[1]);
  }
  const out = [];
  for (const c of crudas) {
    const s = c.trim();
    const q = /^(['"])(.*?)\1/.exec(s);
    const ruta = q ? q[2] : s.replace(/\s+#.*$/, '').trim();
    if (!ruta) continue;
    if (ruta.startsWith('~/')) out.push(path.join(os.homedir(), ruta.slice(2)));
    else if (path.isAbsolute(ruta)) out.push(ruta);
  }
  return out;
}

/**
 * Los repos de la corrida: el de la story y el del código siempre; los de `fileEvents`, los `hermanos` (de
 * `evidence.companion_repos`) y los que nombra la story en `files_to_modify`, sólo con cambios reales. `fileEvents`
 * suma, nunca define: un cambio hecho por consola entra por el repo que lo tiene.
 */
function reposDeLaCorrida({ marker = {}, hermanos = [] } = {}) {
  const fijos = [];
  for (const p of [marker.storyPath, marker.repoPath].filter(Boolean)) {
    const r = raizDe(p);
    if (!r) throw new Error(`${p} no está en un repo de git`);
    fijos.push(r);
  }
  // un evento o un hermano fuera de todo repo (una carpeta temporal) no tiene qué guardar
  const posibles = [
    ...(Array.isArray(marker.fileEvents) ? marker.fileEvents : []).map((e) => e && e.path).filter(Boolean).map(raizDe),
    ...hermanos.map(raizDe),
    ...rutasDeclaradas(marker.storyPath).map(raizDe),
  ].filter(Boolean);
  const out = [...new Set(fijos)];
  for (const r of new Set(posibles)) if (!out.includes(r) && tieneCambios(r)) out.push(r);
  return out;
}

/** La huella de un repo: `{ repo, rama, base, arbol }` (`base` null si `origin/main` no se resuelve; `error` si no se pudo). */
function huella(repo) {
  const rama = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const base = git(repo, ['rev-parse', '--verify', '--quiet', `${BASE}^{commit}`]);
  const gitDir = git(repo, ['rev-parse', '--absolute-git-dir']);
  if (!rama.ok || !gitDir.ok) return { repo, rama: null, base: null, arbol: null, error: rama.err || gitDir.err || 'no es un repo de git' };
  // el árbol que produciría el commit de todo: un índice aparte, desde HEAD, con todo lo del disco (respeta .gitignore).
  // Sin la carpeta de evidencia del pipeline: approve-save escribe ahí su propia aprobación después de tomar la huella
  const indice = path.join(gitDir.out, `save-ok-index-${process.pid}-${Date.now()}`);
  try {
    const env = { GIT_INDEX_FILE: indice };
    const tieneHead = git(repo, ['rev-parse', '--verify', '--quiet', 'HEAD']).ok;
    const pasos = [tieneHead ? ['read-tree', 'HEAD'] : ['read-tree', '--empty'], ['add', '-A'],
      ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', ...PATRONES_EVIDENCIA.map((g) => `:(glob)${g}`)], ['write-tree']];
    let ultimo = null;
    for (const p of pasos) {
      ultimo = git(repo, p, env);
      if (!ultimo.ok) return { repo, rama: rama.out, base: base.ok ? base.out : null, arbol: null, error: `git ${p[0]}: ${ultimo.err}` };
    }
    return { repo, rama: rama.out, base: base.ok && base.out ? base.out : null, arbol: ultimo.out };
  } finally {
    try { fs.unlinkSync(indice); } catch (_) { /* no llegó a existir */ }
  }
}
function huellas(repos) { return repos.map(huella); }

/**
 * ¿El ok sigue valiendo? `{ ok, motivo }`. Cada repo de la huella, en su rama y con su árbol (sin commitear, o ya
 * commiteado igual). Con `push` (`{ remoto, rama }`), la rama de destino es la de la huella del repo de `repoActual`, y
 * nunca `main`.
 */
function vigente({ saveOk, push = null, repoActual = null } = {}) {
  const no = (motivo) => ({ ok: false, motivo });
  if (!saveOk || !Array.isArray(saveOk.huellas) || !saveOk.huellas.length) return no('la corrida no tiene un ok de guardar (saveOk): hay que pedirlo');
  for (const h of saveOk.huellas) {
    const ahora = huella(h.repo);
    if (ahora.error) return no(`${h.repo}: no pude medirlo (${ahora.error})`);
    if (ahora.rama !== h.rama) return no(`${h.repo}: está en la rama ${ahora.rama}, y el ok es de ${h.rama}: hay que pedir otro ok`);
    // el árbol del disco (HEAD más todo lo que no está commiteado): commitear lo mismo no lo cambia, tocar algo sí
    if (ahora.arbol !== h.arbol) return no(`${h.repo}: cambió después del ok: hay que pedir otro ok`);
  }
  if (repoActual && !push) {
    let raiz;
    try { raiz = raizDe(repoActual); } catch (e) { return no(e.message); }
    if (!raiz) return no(`${repoActual} no está en un repo de git: no sé qué repo guarda`);
    if (!saveOk.huellas.some((x) => x.repo === raiz)) return no(`${raiz} no está en el ok de guardar`);
  }
  if (push) {
    if (push.rama === 'main' || push.rama === 'master') return no(`el ok no cubre empujar a ${push.rama}`);
    let raiz = null;
    try { raiz = repoActual ? raizDe(repoActual) : null; } catch (e) { return no(e.message); }
    const h = saveOk.huellas.find((x) => x.repo === raiz);
    if (!h) return no(`${repoActual || 'este repo'} no está en el ok de guardar`);
    if (push.rama !== h.rama) return no(`el ok es para la rama ${h.rama}, no para ${push.rama}`);
  }
  return { ok: true, motivo: null };
}

// ── lo sensible ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Un patrón de SENSITIVE como expresión: `**` cualquier cosa, `*` un tramo sin `/`. */
function patron(p) {
  const re = String(p).toLowerCase().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '\u0001').replace(/\*\*/g, '\u0002').replace(/\*/g, '[^/]*')
    .replace(/\u0001/g, '(?:.*/)?').replace(/\u0002/g, '.*');
  return new RegExp(`^${re}$`);
}

/**
 * Los archivos que cambia un repo: el diff contra el punto donde la rama salió de su base (lo que `main` hizo después
 * no es de la story), sin renombres (origen y destino), y los sin seguimiento. Con `-z`: una ruta con acentos llega
 * tal cual, no entre comillas.
 */
function cambiados(repo) {
  const out = new Set();
  const mb = git(repo, ['merge-base', BASE, 'HEAD']);
  if (!mb.ok || !mb.out) return { error: `no pude ubicar dónde salió la rama de ${BASE} (${mb.err || 'sin salida'})` };
  const d = git(repo, ['diff', '--name-only', '-z', '--no-renames', mb.out]);
  if (!d.ok) return { error: `no pude leer el cambio contra ${BASE} (${d.err})` };
  for (const f of d.crudo.split('\0').filter(Boolean)) out.add(f);
  const sin = git(repo, ['ls-files', '-z', '--others', '--exclude-standard']);
  if (!sin.ok) return { error: `no pude listar los archivos sin seguimiento (${sin.err})` };
  for (const f of sin.crudo.split('\0').filter(Boolean)) out.add(f);
  return { archivos: [...out] };
}

/**
 * ¿El texto hace `require` (o `import … from`) literal de uno de los archivos que definen firmas o avisos, con o sin
 * `.js`? Cada nombre entra a la expresión con todos sus caracteres especiales escapados.
 */
function requiereSensible(texto, lista = catalogo().REQUIERE_SENSIBLE) {
  const nombres = lista.map((n) => n.replace(/\.js$/, '').replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|');
  return new RegExp(`(?:require\\s*\\(\\s*|from\\s+)['"\`](?:[^'"\`]*/)?(?:${nombres})(?:\\.js)?['"\`]`, 'i').test(texto);
}

/**
 * Lo sensible que toca el cambio: `[{ repo, archivo, motivo }]`. Cada repo contra `origin/main`; las rutas sin
 * mayúsculas, también la ruta real del archivo (un enlace a un sensible cuenta), y la clausura de un nivel por `require`.
 */
function sensibles({ repos = [] } = {}) {
  const pats = catalogo().SENSITIVE.map(patron);
  const es = (rel) => pats.some((re) => re.test(String(rel).replace(/\\/g, '/').toLowerCase()));
  const out = [];
  for (const repo of repos) {
    const c = cambiados(repo);
    if (c.error) { out.push({ repo, archivo: '(el cambio)', motivo: `${repo}: ${c.error}` }); continue; }
    const raizReal = real(repo);
    for (const rel of c.archivos) {
      const abs = path.join(repo, rel);
      const relReal = path.relative(raizReal, real(abs));
      if (es(rel) || (!relReal.startsWith('..') && es(relReal))) { out.push({ repo, archivo: rel, motivo: 'está en la lista de lo sensible' }); continue; }
      // la huella y «el último cambio» no miran la evidencia: lo que no es evidencia ahí adentro no pasa sin verse
      if (rel.startsWith(`${EVIDENCIA}/`) && !esEvidencia(rel)) { out.push({ repo, archivo: rel, motivo: 'no es evidencia y está en la carpeta de la evidencia' }); continue; }
      let texto = null;
      try { texto = fs.readFileSync(abs, 'utf8'); } catch (e) {
        // borrado: no carga nada; no poder leerlo (permisos, una carpeta, un submódulo) no prueba que no cargue nada
        if (e.code !== 'ENOENT') { out.push({ repo, archivo: rel, motivo: `no pude leerlo (${e.code || e.message}): no sé qué carga` }); continue; }
      }
      if (texto && requiereSensible(texto)) out.push({ repo, archivo: rel, motivo: 'carga un archivo de firmas o de avisos' });
    }
  }
  return out;
}

// ── la story limpia ─────────────────────────────────────────────────────────────────────────────────────────────────

const ms = (t) => { const n = Date.parse(t); return Number.isFinite(n) ? n : NaN; };

/**
 * Lo que en `repo` es papeleo del pipeline y no código: la evidencia (`esEvidencia`), la story y, en el repo de la
 * story cuando el código vive en otro (los dos declarados), sus `.md` y el estado del sprint. `rutas` para `git`;
 * `es(rel)` para un archivo. Un `.yaml` de CI o de configuración no es papeleo.
 */
function papeleo(marker, repo) {
  const story = marker.storyPath ? raizDe(marker.storyPath) : null;
  const codigo = marker.repoPath ? raizDe(marker.repoPath) : null;
  const relStory = story === repo ? path.relative(repo, real(marker.storyPath)).split(path.sep).join('/') : null;
  const soloPapeles = !!story && !!codigo && story === repo && codigo !== repo;
  const es = (rel) => esEvidencia(rel) || rel === relStory
    || (soloPapeles && (/\.md$/i.test(rel) || path.posix.basename(rel) === 'sprint-status.yaml'));
  const rutas = [...PATRONES_EVIDENCIA.map((g) => `:(exclude,glob)${g}`), ...(relStory ? [`:(exclude,literal)${relStory}`] : []),
    ...(soloPapeles ? [':(exclude,glob)**/*.md', ':(exclude,glob)**/sprint-status.yaml'] : [])];
  return { es, rutas };
}

/**
 * La hora del último cambio de código: el último `fileEvent` de código, el último commit propio de cada repo y los
 * archivos que `git status` ve cambiados, uno por uno; sin el papeleo del pipeline. Lo que no se puede fechar (un git
 * que falla, un borrado, un renombre o un archivo sacado del índice, que conservan la hora vieja del disco) cuenta como
 * recién cambiado.
 */
function ultimoCambio(marker, repos) {
  let max = 0;
  for (const e of Array.isArray(marker.fileEvents) ? marker.fileEvents : []) {
    if (!e || e.code === false) continue;
    const t = ms(e.ts); if (t > max) max = t;
  }
  for (const repo of repos) {
    const p = papeleo(marker, repo);
    // un cambio por consola ya commiteado no deja archivo cambiado: lo fecha su commit
    const mb = git(repo, ['merge-base', BASE, 'HEAD']);
    if (!mb.ok || !mb.out) return Infinity;
    const c = git(repo, ['log', '-1', '--format=%ct', `${mb.out}..HEAD`, '--', '.', ...p.rutas]);
    if (!c.ok) return Infinity;
    if (c.out && Number(c.out) * 1000 > max) max = Number(c.out) * 1000;
    const st = git(repo, ['status', '--porcelain', '-z', '--untracked-files=all']);
    if (!st.ok) return Infinity;
    const ents = st.crudo.split('\0').filter(Boolean);
    for (let i = 0; i < ents.length; i++) {
      const x = ents[i][0];
      const rel = ents[i].slice(3);
      if (/[RC]/.test(x)) i++;   // un renombre trae después su ruta de origen
      if (p.es(rel)) continue;
      if (/[RCD]/.test(x)) return Infinity;
      try { const t = fs.statSync(path.join(repo, rel)).mtimeMs; if (t > max) max = t; } catch (_) { return Infinity; }
    }
  }
  return max;
}

/**
 * De los renglones `-signed` del registro, los de esta corrida: firmados para su sesión, para la que adoptó
 * (`adoptedFrom`, después de un /clear), o para su story. La hora la mira `limpia`.
 */
function exencionesDeLaCorrida(lineas, marker = {}) {
  const sesiones = new Set([marker.sessionId, marker.adoptedFrom].filter(Boolean));
  const story = marker.storyPath ? path.resolve(marker.storyPath) : null;
  // un renglón sin destino no se sabe de quién es: cuenta
  return (lineas || []).filter((g) => g && (!g.destino || sesiones.has(g.destino) || (story && g.storyPath && path.resolve(g.storyPath) === story)));
}

/** Lo que le falta a la corrida para estar limpia (AC 4), o null; con el resumen para el aviso. */
function limpia({ marker, repos, ahora: hs, findings = [], firmasDeLaCorrida = [] }) {
  const falta = (m) => ({ falta: m });
  const pasos = Array.isArray(marker.stepsCompleted) ? marker.stepsCompleted : [];
  if (!pasos.includes('prepare-commit') || !Array.isArray(marker.prepareCommitHuellas)) return falta('la preparación del commit no está cerrada (complete-step prepare-commit)');
  const sinBase = hs.find((h) => !h.base);
  if (sinBase) return falta(`${sinBase.repo}: su base (${BASE}) no se puede resolver`);
  const medida = hs.find((h) => h.error);
  if (medida) return falta(`${medida.repo}: no pude medirlo (${medida.error})`);
  const prev = new Map(marker.prepareCommitHuellas.map((h) => [h.repo, h]));
  const otra = hs.find((h) => { const p = prev.get(h.repo); return !p || p.rama !== h.rama || p.arbol !== h.arbol; });
  if (otra || prev.size !== hs.length) return falta(`${otra ? otra.repo : 'la corrida'}: cambió después de preparar el commit`);
  const ultimo = ultimoCambio(marker, repos);
  const checks = marker.checks || {};
  const prov = (marker.checksProvenance || {}).tests;
  if (checks.tests !== 'green' || prov !== 'test-gate') return falta(`las pruebas no están en verde por la suite completa (test-gate): ${checks.tests || 'sin correr'}, ${prov || 'sin procedencia'}`);
  if (!(ms((marker.checksAt || {}).tests) >= ultimo)) return falta('las pruebas son anteriores al último cambio de código');
  // el pase: cerrado con su resultado, o salteado por la regla del portón; nunca con firma ni abandonado
  const sk = marker.adversarialSkip && typeof marker.adversarialSkip === 'object' ? marker.adversarialSkip : null;
  let pase;
  if (sk && (sk.firmado || sk.forzado)) return falta('el pase adversarial se salteó con una firma');
  if (sk && sk.abandonado) return falta('el pase adversarial se abandonó');
  const del5b = (Array.isArray(marker.adversarialPasses) ? marker.adversarialPasses : []).filter((p) => p && p.tipo === '5b');
  if (marker.adversarial) {
    const desde = ms(marker.adversarial.launchedAt);
    const vig = del5b.filter((p) => ms(p.ts) >= desde);
    const ult = vig[vig.length - 1];
    if (!ult) return falta('el pase adversarial se lanzó y no tiene resultado');
    if (ult.veredicto === 'no-medido') return falta('el pase adversarial no midió todo');
    if (!(ms(ult.ts) >= ultimo)) return falta('el pase adversarial es anterior al último cambio de código');
    pase = `el pase cerrado con ${Number(ult.confirmados) || 0} confirmados`;
  } else if (sk) {
    if (!(ms(sk.at) >= ultimo)) return falta('el salteo del pase es anterior al último cambio de código');
    pase = `el pase salteado por la regla: ${/livian/i.test(String(sk.motivo || '')) || sk.sizeForced ? 'corrida liviana' : 'riesgo bajo'}`;
  } else return falta('el pase adversarial no corrió ni se salteó');
  const criticos = findings.filter((f) => f && String(f.severity).toUpperCase() === 'CRITICAL');
  if (criticos.length) return falta(`${criticos.length} hallazgo(s) CRITICAL en la corrida (${criticos.map((f) => f.rule_id).join(', ')}), aunque estén eximidos`);
  const desde = ms(marker.startedAt);
  const exime = firmasDeLaCorrida.find((g) => g && EXIMEN.some((f) => g.name === `${f}-signed`) && !(ms(g.ts) < desde));
  if (exime) return falta(`la corrida tiene una firma que exime algo (${exime.name.replace(/-signed$/, '')})`);
  return { falta: null, resumen: { criticos: 0, pase } };
}

// ── el aviso al dueño ───────────────────────────────────────────────────────────────────────────────────────────────

function lineaDelAviso({ marker, repos, resumen }) {
  const nombres = repos.map((r) => path.basename(r)).join(', ');
  return `Ok de guardar: la coordinadora dio el ok de la story ${marker.storyId} (${nombres}). `
    + `Comprobada limpia: ${resumen.criticos} críticos, ${resumen.pase}, las pruebas en verde.`;
}

/**
 * El aviso por los canales de la lista del perfil, nunca el de la máquina: `{ ok, canales, motivo }`. Vale sólo con
 * una entrega real de al menos un canal. `canales()`: notify.canalesDeLaSesion; `mandar(o)`: notify.avisar.
 */
function avisar({ texto, canales, mandar }) {
  const no = (motivo) => ({ ok: false, motivo });
  let c;
  try { c = canales(); } catch (e) { return no(`no pude leer los canales de aviso (${e.message})`); }
  if (!c || c.problema) return no(`los canales de aviso no se pudieron leer${c && c.problema ? ` (${c.problema})` : ''}`);
  if (c.origen !== 'perfil') return no('el perfil del equipo no trae la lista de canales de aviso (integrations.notify.channels)');
  if (!Array.isArray(c.canales) || !c.canales.length) return no('la lista de canales de aviso del perfil está vacía');
  let r;
  try { r = mandar({ canales: c.canales, texto, lado: 'sesion', mail: c.mail || null, chat: c.chat || null }); } catch (e) { return no(`el aviso falló (${e.message})`); }
  const entregados = ((r && r.resultados) || []).filter((x) => x && x.entregado === true && x.canal);
  if (!entregados.length) return no(`el aviso no llegó por ningún canal${((r && r.resultados) || []).map((x) => (x && x.motivo ? ` (${x.canal}: ${x.motivo})` : '')).join('')}`);
  return { ok: true, canales: entregados.map((x) => x.canal) };
}

// ── antes de la firma y la constancia ───────────────────────────────────────────────────────────────────────────────

/**
 * Lo que corre con el pedido a la vista y sin gastarlo: `{ codigo: 0, huellas, canales? }`, o `{ codigo, motivo }` sin
 * avisar ni escribir. Por delegación: limpia (2), nada sensible (2) y el aviso entregado (1). Por la ventana o la
 * terminal, sólo las huellas: el dueño decide.
 */
function antesDeFirmar({ via, marker, repos, findings = [], firmasDeLaCorrida = [], canales, mandar }) {
  const hs = huellas(repos);
  if (via !== 'delegacion') return { codigo: 0, huellas: hs };
  // lo sensible primero: el motivo nombra el archivo aunque además falte algo para estar limpia
  const s = sensibles({ repos });
  if (s.length) return { codigo: 2, motivo: `la coordinadora no puede dar el ok: el cambio toca ${s.map((x) => `${x.archivo} (${path.basename(x.repo)}: ${x.motivo})`).join(', ')}. Lo firma una persona: ni el agente ni la coordinadora` };
  const l = limpia({ marker, repos, ahora: hs, findings, firmasDeLaCorrida });
  if (l.falta) return { codigo: 2, motivo: `la coordinadora no puede dar el ok: ${l.falta}. Lo firma una persona: ni el agente ni la coordinadora` };
  const a = avisar({ texto: lineaDelAviso({ marker, repos, resumen: l.resumen }), canales, mandar });
  if (!a.ok) return { codigo: 1, motivo: `sin aviso a la persona no hay ok: ${a.motivo}` };
  return { codigo: 0, huellas: hs, canales: a.canales };
}

/** El `saveOk` que queda en el marcador de la corrida (y en el renglón `save-signed`). */
function constancia({ marker, via, por = null, previo, ahora }) {
  return {
    via, ...(por ? { por } : {}), ts: ahora, storyId: marker.storyId || null, startedAt: marker.startedAt || null,
    huellas: previo.huellas, ...(previo.canales ? { canales: previo.canales } : {}),
  };
}

module.exports = { FIRMA: 'save', raizDe, rutasDeclaradas, reposDeLaCorrida, exencionesDeLaCorrida, requiereSensible, huella, huellas, vigente, sensibles, limpia, lineaDelAviso, avisar, antesDeFirmar, constancia };
