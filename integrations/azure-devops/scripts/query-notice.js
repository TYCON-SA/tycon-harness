'use strict';
/**
 * query-notice.js — lo de Azure DevOps del aviso de consultas fallidas (scripts/hooks/failed-query-notice.js).
 *
 * El gancho es neutro: corta el comando en segmentos y avisa cuando una consulta devolvió vacío con el código de salida
 * tapado. Qué comando de esta plataforma es una consulta, y el aviso propio de la plataforma, viven acá:
 *   · `clasificar({ pos, limpio })`: un `az … list/show` (y `az devops invoke` sin método de escritura) es una
 *     consulta; uno con un verbo que escribe (`create`, `update`, `login`…) no.
 *   · `avisos(cmd, { segmentos, tokens, PREFIJOS, stateDir })`: «ese proyecto no existe». En los segmentos
 *     `az repos|pipelines|boards|artifacts|devops …` (y SÓLO ahí: `az login -p` es una contraseña, `mkdir -p` no es az)
 *     compara el `--project`/`-p` contra la lista de proyectos de la organización guardada por `refrescar` (el
 *     instalador la refresca cada 7 días en segundo plano si hay `az`; sin lista, o con lista de más de 30 días, calla).
 *     Un GUID se acepta (az lo admite), una variable no se juzga. El aviso sugiere hasta 3 parecidos y NO vuelca la
 *     lista: los nombres de clientes no van al contexto.
 *   · `refrescar(org, { stateDir })`: guarda la lista de proyectos; lo llama `failed-query-notice.js --refresh`.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const programas = ['az'];
const LEE = new Set(['list', 'show', 'ls', 'get', 'query', 'search', 'check', 'status', 'diff', 'version', 'validate']);
const ESCRIBE = new Set(['login', 'logout', 'configure', 'create', 'delete', 'update', 'set', 'add', 'remove', 'import', 'upload', 'push', 'publish', 'queue', 'cancel', 'approve', 'vote', 'complete', 'merge', 'install', 'run', 'rerun', 'reject', 'abandon', 'reactivate', 'download']);
// las opciones globales que pueden ir antes del grupo y llevan valor (`az -o json repos pr list`)
const conValor = new Set(['-o', '--output', '--query', '--subscription']);
// un método que no es GET, con espacio, con «=» o pegado a la opción corta: `az devops invoke --http-method POST`,
// `az rest --method=put`, `az rest -m delete`, `az rest -mput`
const NO_GET = (opciones) => new RegExp(`(?:^|\\s)(?:${opciones})\\s*['"]?(?!GET\\b)[A-Za-z]`, 'i');
const ESCRIBE_INVOKE = NO_GET('--http-method[=\\s]');
const ESCRIBE_REST = NO_GET('--method[=\\s]|-m[=\\s]?');

/** 'consulta' u 'otro', con el grupo y el verbo del comando (`pos`) y el segmento sin prefijos (`limpio`). */
function clasificar({ pos, limpio }) {
  if (pos.some((p) => ESCRIBE.has(p))) return 'otro';
  // `az rest` sin método es un GET
  if (pos[0] === 'rest') return ESCRIBE_REST.test(limpio) ? 'otro' : 'consulta';
  const invoke = pos[0] === 'devops' && pos.includes('invoke') && !ESCRIBE_INVOKE.test(limpio);
  return LEE.has(pos[pos.length - 1]) || invoke ? 'consulta' : 'otro';
}

const CACHE_MAX_DIAS = 30;
const cacheDe = (stateDir) => path.join(stateDir(os.homedir()), 'az-projects.json');
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CON_PROYECTO = new Set(['repos', 'pipelines', 'boards', 'artifacts']);

/** los valores de --project/-p de los segmentos az que HABLAN de un proyecto */
function proyectos(cmd, { segmentos, tokens, PREFIJOS, programaDe, palabras }) {
  const out = [];
  const segs = segmentos(cmd);
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    let fin = i; while (segs[fin] && segs[fin].sep === '|') fin++;
    if (segs[fin] && segs[fin].sep === '&') continue;           // al fondo por el shell: su resultado no está acá
    const argv = tokens(seg.texto.replace(PREFIJOS, ''));
    // `az`, `az.cmd`, `C:\…\az.exe`, `AZ` (lo lee el gancho como a cualquier programa)
    if (!argv.length || programaDe(argv[0]).toLowerCase() !== 'az') continue;
    const pos = palabras(argv, conValor);
    const habla = CON_PROYECTO.has(pos[0]) || (pos[0] === 'devops' && !['configure', 'login', 'logout', 'project', 'extension', 'user'].includes(pos[1]));
    if (!habla) continue;
    for (let j = 1; j < argv.length; j++) {
      let v = null;
      if (argv[j] === '--project' || argv[j] === '-p') v = argv[j + 1];
      else if (argv[j].startsWith('--project=')) v = argv[j].slice('--project='.length);
      if (v == null || v === '' || v.startsWith('$') || v.startsWith('-') || GUID.test(v)) continue;
      out.push(v);
    }
  }
  return out;
}

function proyectosGuardados(stateDir) {
  try {
    const d = JSON.parse(fs.readFileSync(cacheDe(stateDir), 'utf8'));
    if (!Array.isArray(d.proyectos) || !d.proyectos.length) return null;
    const edad = d.fecha ? (Date.now() - Date.parse(d.fecha)) / 86400000 : 0;
    if (Number.isFinite(edad) && edad > CACHE_MAX_DIAS) return null;   // vieja: peor que ninguna
    return { proyectos: d.proyectos.filter((p) => typeof p === 'string'), fecha: d.fecha || null };
  } catch { return null; }
}

function parecidos(nombre, lista) {
  const n = nombre.toLowerCase();
  const palabras = n.split(/[\s_-]+/).filter(Boolean);
  const puntaje = (p) => {
    const q = p.toLowerCase();
    if (q === n) return 100;
    if (q.startsWith(n) || n.startsWith(q)) return 50;
    if (palabras.some((w) => w.length >= 3 && q.split(/[\s_-]+/).includes(w))) return 20;
    return 0;
  };
  return lista.map((p) => [puntaje(p), p]).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0]).slice(0, 3).map(([, p]) => p);
}

/** Los avisos de la plataforma para el comando: el proyecto que no existe en la organización. */
function avisos(cmd, ayuda) {
  const out = [];
  const proys = proyectos(cmd, ayuda);
  const guardados = proys.length ? proyectosGuardados(ayuda.stateDir) : null;
  if (!guardados) return out;
  for (const proy of [...new Set(proys)]) {
    if (guardados.proyectos.some((p) => p.toLowerCase() === proy.toLowerCase())) continue;
    const suger = parecidos(proy, guardados.proyectos);
    out.push(
      `⚠️  \`--project ${proy.slice(0, 60)}\` no existe en la organización (${guardados.proyectos.length} proyectos, lista cacheada${guardados.fecha ? ` el ${guardados.fecha.slice(0, 10)}` : ''})` +
      (suger.length ? ` — ¿será ${suger.map((s) => `«${s}»`).join(' o ')}?` : ' — si es un proyecto nuevo, refrescá la lista: `node <tcg>/scripts/hooks/failed-query-notice.js --refresh`') + '.\n' +
      '   Con ese nombre az FALLA siempre: un listado vacío ahí no es «no hay», es «no pude preguntar».\n',
    );
  }
  return out;
}

/** Guarda la lista de proyectos de la organización (`org`, o la configurada en az). Código de salida. */
function refrescar(org, { stateDir }) {
  const { execFileSync } = require('child_process');
  let o = org;
  if (!o) {
    try { const m = execFileSync('az', ['devops', 'configure', '-l'], { windowsHide: true, encoding: 'utf8', timeout: 15000 }).match(/organization\s*=\s*(\S+)/); o = m && m[1]; } catch { /* sin az */ }
  }
  if (!o) { console.error('consulta-fallida-notice: no sé la organización (pasá --org <url>)'); return 2; }
  let lista;
  try {
    const raw = JSON.parse(execFileSync('az', ['devops', 'project', 'list', '--org', o, '--top', '500', '-o', 'json'], { windowsHide: true, encoding: 'utf8', timeout: 60000 }));
    lista = (Array.isArray(raw) ? raw : raw.value).map((p) => p.name).filter((n) => typeof n === 'string');
  } catch (e) { console.error(`consulta-fallida-notice: no pude listar los proyectos (${(e.message || '').slice(0, 120)})`); return 2; }
  if (!lista.length) { console.error('consulta-fallida-notice: la lista vino vacía; no piso la cache'); return 2; }
  const cache = cacheDe(stateDir);
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  fs.writeFileSync(cache, JSON.stringify({ org: o, fecha: new Date().toISOString(), proyectos: lista }, null, 2) + '\n');
  console.log(`consulta-fallida-notice: ${lista.length} proyectos cacheados en ${cache}`);
  return 0;
}

module.exports = { programas, conValor, clasificar, avisos, refrescar, proyectos };
