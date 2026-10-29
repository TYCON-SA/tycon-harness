#!/usr/bin/env node
'use strict';
/**
 * github-issues.js — el aviso de dependencias como issue de GitHub.
 *
 * ── POR QUÉ EXISTE ──────────────────────────────────────────────────────────────────────────────
 * En Azure DevOps cada ficha viva de la revisión nocturna se convierte en un Bug en el proyecto del equipo dueño del
 * código (`work-items.js`). Una organización que vive en GitHub no tiene Azure Boards: el lugar natural del aviso es un
 * ISSUE en el repo del producto. Este guion hace lo mismo que `work-items.js`, con la misma interfaz (`run`, `state`), la
 * misma sección `pedidos` del snapshot y el mismo volcado `bugs-<fecha>.json`, para que el nocturno, el resumen y el
 * aviso de arranque no tengan que saber de qué plataforma salió. Lo elige `work-items.js` cuando `team-repos.json` dice
 * `operations.platform: github`.
 *
 * ── LO QUE CAMBIA RESPECTO DE AZURE ─────────────────────────────────────────────────────────────
 * · EL «PROYECTO» ES EL REPO. Cada entrada de `repos.json` declara `github: <dueño>/<repo>`: una ficha por (paquete,
 *   repo), un issue por ficha, en ese repo. La línea de la ficha es `  - <dueño>/<repo>: <número>`.
 * · EL NÚMERO SE REPITE ENTRE REPOS. En el volcado cada pedido va con la clave `<dueño>/<repo>#<n>` y el volcado dice
 *   `plataforma: "github"` (el nocturno lo usa para buscar). En la sección `pedidos` el `id` sigue siendo el número.
 * · NO HAY DUEÑO DEDUCIDO. Se asigna a `owners.by_project["<dueño>/<repo>"]` de `operations.json` o, si no está, a
 *   `owners.default` (el responsable de respaldo), al que además se menciona. Sin `operations.json` no se crea nada: en
 *   GitHub no hay un respaldo en `repos.json`.
 * · LO QUE HIZO EL ARNÉS LLEVA UNA MARCA (`<!-- arnes-nocturno:<id> -->`) en el cuerpo y en cada comentario, además de
 *   salir de la identidad que corre la noche (`github.identity` de repos.json, o la del token por `GET /user`). Con una
 *   cuenta compartida (el token personal del dueño) la cuenta no alcanza para separar al arnés de una persona; la marca
 *   sí. Sólo se CIERRA un issue con la marca en el cuerpo y abierto por esa identidad; sólo se REABRE uno que esa
 *   identidad cerró el día de su marca de cierre. Sin identidad conocida no se cierra ni se reabre nada (se comenta).
 *
 * ── LO QUE NO CAMBIA (las reglas de work-items.js) ────────────────────────────────────────────
 * · Un pedido tiene dos identidades: la línea en la ficha y la etiqueta `arnes:<id>` en GitHub. Se busca por el LISTADO
 *   de issues del repo (`state=all`, sin pull requests, paginado), nunca por la búsqueda: la búsqueda tarda en ver un
 *   issue recién creado y nacerían duplicados. «No pude preguntar» no es «no hay»: no se crea nada.
 * · El tope cuenta fichas; las críticas no lo consumen; los reintentos de anoche van primero.
 * · Nace apagado: sin `github.issues_enabled: true` (o con `--simulate`) lee y dice qué habría hecho, sin escribir nada.
 * · GitHub descarta EN SILENCIO un asignado sin acceso al repo: la respuesta se mira, y si no quedó, es un fallo.
 * · Un issue borrado (410) o movido a otro repo no se recrea ni se toca: es un fallo con su motivo, todas las noches,
 *   hasta que una persona decida. Una credencial que responde 401 es «no pude intentar nada» (sale 2).
 *
 * ── USO ─────────────────────────────────────────────────────────────────────────────────────────
 *   node github-issues.js run    [--config <f>] [--operations <f>] [--pending <dir>] [--out <dir>] [--today <fecha>]
 *                                [--simulate] [--json]
 *   node github-issues.js state  [--config <f>] [--pending <dir>] [--out <dir>] [--today <fecha>]
 * Buscar los issues de una ficha y crearlos va por la capa de plataforma (`work-item.find` y `work-item.create` del
 * conector de GitHub), como en Azure; lo demás habla con GitHub por `gh api`. Los dos usan TYCON_GH_CMD (un ejecutable,
 * o un `.js` que corre con node) y necesitan GH_TOKEN (o GITHUB_TOKEN).
 * Exit: 0 habló con GitHub (los fallos por par van al snapshot) · 2 no pudo intentar nada.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const noc = require('./nightly-dependencies');
const wi = require('./work-items');
const operaciones = require('../../lib/operations-config.js');

/** La capa de plataforma con el conector de GitHub: `(operación, args) → Promise<resultado del contrato>`. */
function plataformaGithub() {
  const P = require('../../lib/platform/platform.js');
  const INT = require('../../lib/integrations.js');
  return (op, args) => {
    const manifiesto = INT.find('github', { kind: 'platform', env: process.env });
    if (!manifiesto) return Promise.resolve({ ok: false, reason: 'sin_plataforma', detail: 'no está el conector de GitHub' });
    return P.call(manifiesto, op, args, { env: process.env });
  };
}
/** El motivo de un «no» de la plataforma, para la ficha; una credencial que no sirve corta la corrida entera. */
function motivoPlataforma(r) {
  if (r && r.ok === false && r.reason === 'sin_credencial') throw new NoSePuedeIntentar(`la credencial no sirve: ${recortar(r.detail, 160)}`);
  return r && typeof r.reason === 'string' ? `${r.reason}: ${recortar(r.detail)}` : 'la plataforma no contestó';
}

const { listaDe, ponerLista, proyectoDe, proyectoAzureDe, etiqueta, leerTodasLasFichas, leerPedidos, cuerpoDeFicha } = noc;

const DIAS_SIN_PEDIDO = 7;
const ETIQUETA = 'arnes-hallazgo';
const MARCA = (id) => `<!-- arnes-nocturno:${id} -->`;
const TIENE_MARCA = /<!-- arnes-nocturno:[A-Za-z0-9_-]+ -->/;
const REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const POR_PAGINA = 100;
const MAX_PAGINAS = 30;

const recortar = (t, n = 300) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, n) || '(sin salida)';
const diasEntre = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const igual = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
const porFicha = (a, b) => String(a.ficha).localeCompare(String(b.ficha)) || String(a.proyecto || '').localeCompare(String(b.proyecto || ''));

class NoSePuedeIntentar extends Error {}

// ── la conversación con GitHub ─────────────────────────────────────────────────────────────────

/**
 * `gh(método, ruta, { cuerpo, valida })` → `{ ok, valor, http, motivo }`.
 * Se decide por el código de salida y la legibilidad, nunca por «salida vacía». Un 401 corta la corrida entera: con una
 * credencial que no sirve, todo lo que siga sería «no pude» leído pedido por pedido.
 */
function crearGh({ cmd, tmp }) {
  let n = 0;
  return function gh(metodo, ruta, { cuerpo = null, valida = null } = {}) {
    const args = ['api', '--method', metodo, '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28', ruta];
    if (cuerpo !== null) {
      const f = path.join(tmp, `${++n}-cuerpo.json`);
      fs.writeFileSync(f, JSON.stringify(cuerpo));
      args.push('--input', f);
    }
    const [exe, pre] = /\.js$/i.test(cmd) ? [process.execPath, [cmd]] : [cmd, []];
    const r = spawnSync(exe, [...pre, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120000, env: process.env });
    if (r.error && r.error.code === 'ENOENT') throw new NoSePuedeIntentar(`no se pudo ejecutar ${cmd}: ${r.error.message}`);
    if (r.error) return { ok: false, http: null, motivo: `${cmd} no terminó (${r.error.message})` };
    let valor = null;
    const texto = String(r.stdout || '').trim();
    let legible = true;
    if (texto) { try { valor = JSON.parse(texto); } catch { legible = false; } }
    if (r.status !== 0) {
      const m = String(r.stderr || '').match(/HTTP (\d{3})/);
      const http = valor && valor.status ? Number(valor.status) : (m ? Number(m[1]) : null);
      if (http === 401) throw new NoSePuedeIntentar(`la credencial no sirve: GitHub respondió 401 (${recortar(r.stderr || texto, 160)})`);
      return { ok: false, http, motivo: `${http ? `HTTP ${http}` : `salió ${r.status}`}: ${recortar((valor && valor.message) || r.stderr || texto)}` };
    }
    if (!legible) return { ok: false, http: null, motivo: `la respuesta no es JSON: ${recortar(texto, 120)}` };
    const m = valida ? valida(valor) : null;
    return m ? { ok: false, http: null, motivo: m } : { ok: true, valor, http: 200 };
  };
}

/** Un listado paginado: `{ ok, valor: [...] }` o `{ ok: false, motivo }`. Nunca «lo que alcancé a leer». */
function paginar(gh, ruta) {
  const todos = [];
  const sep = ruta.includes('?') ? '&' : '?';
  for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
    const r = gh('GET', `${ruta}${sep}per_page=${POR_PAGINA}&page=${pagina}`, { valida: (v) => (Array.isArray(v) ? null : 'la respuesta no es una lista') });
    if (!r.ok) return r;
    todos.push(...r.valor);
    if (r.valor.length < POR_PAGINA) return { ok: true, valor: todos };
  }
  return { ok: false, motivo: `más de ${MAX_PAGINAS * POR_PAGINA} elementos en ${ruta}: no leo a medias` };
}

const etiquetasDe = (issue) => (Array.isArray(issue && issue.labels) ? issue.labels : [])
  .map((l) => String(typeof l === 'string' ? l : (l && l.name) || '').toLowerCase());

/** Los issues de un repo con la etiqueta de la ficha (sin pull requests). */
function issuesConEtiqueta(gh, repo, nombre) {
  const r = paginar(gh, `repos/${repo}/issues?labels=${encodeURIComponent(nombre)}&state=all`);
  if (!r.ok) return r;
  return { ok: true, valor: r.valor.filter((i) => i && !i.pull_request && Number.isInteger(i.number) && etiquetasDe(i).includes(nombre.toLowerCase())) };
}

/**
 * Lee el issue y verifica que sea el de la ficha: de ese repo (uno transferido responde con el del otro), no un pull
 * request, y con la etiqueta. `{ ok, issue }` · `{ ok: false, borrado?, ajeno?, motivo }`.
 */
function leerSuIssue(gh, repo, n, idFicha, { exigirEtiqueta = true } = {}) {
  const r = gh('GET', `repos/${repo}/issues/${n}`, { valida: (v) => (v && typeof v.state === 'string' ? null : 'la respuesta no trae «state»') });
  if (!r.ok) {
    if (r.http === 410) return { ok: false, borrado: true, motivo: `el issue ${repo}#${n} fue borrado (410): no se recrea solo, una persona decide` };
    if (r.http === 404) return { ok: false, motivo: `el issue ${repo}#${n} no existe o no hay permiso de lectura (404)` };
    return { ok: false, motivo: `no pude leer el issue ${repo}#${n} (${r.motivo})` };
  }
  const i = r.valor;
  const deEste = String(i.repository_url || '').toLowerCase().endsWith(`/repos/${repo.toLowerCase()}`);
  if (i.pull_request || !deEste || (exigirEtiqueta && !etiquetasDe(i).includes(`arnes:${idFicha}`.toLowerCase()))) {
    return { ok: false, ajeno: true, motivo: `${repo}#${n} no es el issue de esta ficha (${i.pull_request ? 'es un pull request' : !deEste ? `está en otro repo: ${i.repository_url || '?'}` : `sin la etiqueta arnes:${idFicha}`})` };
  }
  return { ok: true, issue: i };
}

/** ¿Lo abrió el arnés? La marca en el cuerpo Y la identidad que corre. Sin identidad conocida, no se afirma. */
const abiertoPorArnes = (issue, ident) => !!(ident && ident.ok && TIENE_MARCA.test(String(issue.body || ''))
  && igual(issue.user && issue.user.login, ident.login));

/** Categoría de Azure equivalente: abierto → Proposed; completed → Completed; lo demás → Removed. */
function categoriaDe(issue) {
  if (issue.state === 'open') return 'Proposed';
  return issue.state_reason === 'completed' ? 'Completed' : 'Removed';
}

/** La identidad con la que corre la noche: la declarada en repos.json, o la del token. */
function leerIdentidad(gh, cfg) {
  const declarada = cfg.github && typeof cfg.github.identity === 'string' ? cfg.github.identity.trim() : '';
  if (declarada) return { ok: true, login: declarada, fuente: 'repos.json' };
  const r = gh('GET', 'user', { valida: (v) => (v && typeof v.login === 'string' ? null : 'la respuesta no trae «login»') });
  if (r.ok) return { ok: true, login: r.valor.login, fuente: 'token' };
  return { ok: false, motivo: `no sé con qué cuenta corre la noche (${r.motivo}): sin eso no cierro ni reabro nada; declarala en github.identity de repos.json` };
}

/** Quién responde: operations.json, obligatorio en GitHub. */
function responsables(a) {
  if (!fs.existsSync(a.operations)) return { ok: false, motivo: `sin responsable de respaldo: no está ${a.operations} (en GitHub no hay respaldo en repos.json)` };
  const r = operaciones.load(a.operations);
  if (!r.ok) return { ok: false, motivo: `sin responsable de respaldo: ${a.operations} no sirve (${r.problems.map((p) => (p.path ? `${p.path}: ${p.message}` : p.message)).join('; ')}) — no se adivina` };
  const bp = r.data.owners.by_project || {};
  return { ok: true, respaldo: r.data.owners.default,
    declarado: (repo) => { const k = Object.keys(bp).find((x) => !x.startsWith('__') && igual(x, repo)); return k ? bp[k] : null; } };
}

/** La cuenta del responsable de respaldo existe: `{ ok, login }` o `{ ok: false, motivo }`. */
function resolverRespaldo(gh, login) {
  if (!login || !/^[A-Za-z0-9-]+$/.test(login)) return { ok: false, motivo: `el responsable de respaldo «${login || ''}» no es un usuario de GitHub` };
  const r = gh('GET', `users/${login}`, { valida: (v) => (v && typeof v.login === 'string' ? null : 'la respuesta no trae «login»') });
  return r.ok ? { ok: true, login: r.valor.login } : { ok: false, motivo: `no pude resolver al responsable de respaldo ${login} (${r.motivo})` };
}

/** Los repos de GitHub de la config; una entrada de Azure es una mezcla de plataformas. */
function validarConfig(cfg) {
  const repos = Array.isArray(cfg.repos) ? cfg.repos : [];
  const azure = repos.filter((r) => r && r.ado).map((r) => r.ruta);
  if (azure.length) return `repos.json trae entradas de Azure (${azure.join(', ')}) y la plataforma de la organización es GitHub: una organización, una plataforma`;
  const malos = repos.filter((r) => r && r.activo !== false && r.github !== undefined && !REPO.test(String(r.github))).map((r) => r.ruta);
  if (malos.length) return `repos.json trae entradas con un «github» que no es <dueño>/<repo>: ${malos.join(', ')}`;
  return null;
}

// ── la corrida ─────────────────────────────────────────────────────────────────────────────────

function comentarioCuerpo(texto, idFicha) { return `${texto}\n\n${MARCA(idFicha)}`; }

async function hablar(ctx) {
  const { gh, cfg, hoy, simulado, tope, fichas, ident } = ctx;
  const plataforma = ctx.plataforma || plataformaGithub();
  // la configuración del pedido de trabajo se lee del repo de operaciones; el repo de cada issue lo trae el pedido
  const repoDir = ctx.repoDir || process.cwd();
  const res = {
    plataforma: 'github', simulado, tope, fichas_vivas: 0, fichas_sin_pedido: 0, creados: [], adoptados: [], existentes: 0,
    fallidos: [], postergados: [], sin_iteracion: [], sin_dueno_unico: [], pagados_avisados: [], reabiertos: [],
    deuda_avisada: [], sin_pedido: [], cerrados_vivos_avisados: [], huerfanos_adoptados: [], huerfanos_sin_adoptar: [],
  };
  const textos = [];
  if (!ident.ok) ctx.avisosDeSalida.push(ident.motivo);

  wi.adoptarHuerfanos(ctx, res);

  const pares = wi.paresPorPedir(fichas, cfg);
  res.fichas_vivas = pares.length;
  res.existentes = pares.reduce((n, x) => n + x.conPedido.length, 0);
  const sinPedido = pares.filter((x) => x.faltan.length);
  res.fichas_sin_pedido = sinPedido.length;
  const clavePaquete = (f, p) => `${String(f.fi.escalares.paquete || '').toLowerCase()}|${p.toLowerCase()}`;
  const pedidoDelPaquete = new Map();
  for (const x of [...pares].sort((a, b) => String(a.ficha.idFicha).localeCompare(String(b.ficha.idFicha)))) {
    for (const { proyecto, id } of leerPedidos(x.ficha.txt)) {
      if (!pedidoDelPaquete.has(clavePaquete(x.ficha, proyecto))) pedidoDelPaquete.set(clavePaquete(x.ficha, proyecto), { ficha: x.ficha.idFicha, id });
    }
  }
  const anoche = wi.fallidasDeAnoche(ctx.out, hoy);
  if (anoche.aviso) ctx.avisosDeSalida.push(anoche.aviso);
  const { elegidas, postergadas } = wi.ordenarYTopar(sinPedido, tope, anoche.ids);
  for (const x of postergadas) res.postergados.push({ ficha: x.ficha.idFicha, proyectos: x.faltan });

  const quien = ctx.responsables;
  let respaldo = null, motivoRespaldo = null, leido = false;
  const respaldoDe = () => {
    if (!leido) {
      leido = true;
      const r = quien.ok ? resolverRespaldo(gh, quien.respaldo) : { ok: false, motivo: quien.motivo };
      if (r.ok) respaldo = r; else motivoRespaldo = r.motivo;
    }
    return respaldo ? { ok: true, ...respaldo } : { ok: false, motivo: motivoRespaldo };
  };
  if (elegidas.length) respaldoDe();
  const comentar = (repo, n, texto, idFicha) => gh('POST', `repos/${repo}/issues/${n}/comments`, { cuerpo: { body: comentarioCuerpo(texto, idFicha) },
    valida: (v) => (v && v.id !== undefined ? null : 'la respuesta no trae «id»') });

  for (const x of elegidas) {
    const f = x.ficha, idFicha = f.idFicha;
    for (const repo of x.faltan) {
      const fallo = (paso, motivo) => res.fallidos.push({ ficha: idFicha, proyecto: repo, paso, motivo });
      if (!respaldo) { fallo('lead-identity', motivoRespaldo); continue; }
      if (!/^[A-Za-z0-9_-]+$/.test(idFicha)) { fallo('duplicados', `no pude consultar duplicados (el id «${idFicha}» no es seguro para una consulta)`); continue; }
      const otra = pedidoDelPaquete.get(clavePaquete(f, repo));
      if (otra && otra.ficha !== idFicha) {
        fallo('duplicados', `otra ficha viva del mismo paquete ya tiene issue en ${repo}: ${otra.ficha} (issue ${otra.id === null ? 'que se crearía esta noche' : `#${otra.id}`}) — son dos fichas para el mismo hecho; una persona decide cuál queda`);
        continue;
      }
      // Duplicados: los issues del repo con la etiqueta exacta de la ficha. Una búsqueda que no se pudo hacer no crea.
      let w;
      try { w = await plataforma('work-item.find', { repoDir, repo, tag: `arnes:${idFicha}` }); } catch { w = null; }
      if (!(w && w.ok === true && w.value && Array.isArray(w.value.ids))) { fallo('duplicados', `no pude consultar duplicados (${motivoPlataforma(w)})`); continue; }
      const nuestros = w.value.ids.filter(Number.isInteger);
      if (nuestros.length > 1) { fallo('duplicados', `issues duplicados en ${repo}: ${nuestros.map((x) => `#${x}`).sort().join(', ')} — una persona decide cuál queda`); continue; }
      if (nuestros.length === 1) {
        const n = nuestros[0];
        pedidoDelPaquete.set(clavePaquete(f, repo), { ficha: idFicha, id: n });
        if (!simulado) {
          try { wi.anotarPedido(f.archivo, repo, n); }
          catch (e) { fallo('escribir-ficha', `no pude anotar el issue adoptado #${n}: ${e.message}`); continue; }
          const k = comentar(repo, n, `@${respaldo.login} — este issue ya existía con la etiqueta \`arnes:${idFicha}\` y la ficha no lo tenía anotado (se perdió el registro de una noche anterior, o la creación respondió con error aunque se hizo): la revisión nocturna lo adopta.`, idFicha);
          if (!k.ok) fallo('comentario', `adopté el issue #${n} pero no pude comentarlo: ${k.motivo}`);
        }
        res.adoptados.push({ ficha: idFicha, proyecto: repo, id: n });
        continue;
      }
      const declarado = quien.declarado(repo);
      const asignado = declarado || respaldo.login;
      const motivoDueno = declarado ? 'declarado en operations.json' : 'responsable de respaldo (sin responsable declarado para este repo)';
      const reposP = f.fi.listas.repos.filter((r) => proyectoAzureDe(r, cfg) === repo);
      const titulo = `Dependencia vulnerable: ${f.fi.escalares.paquete} (${f.fi.escalares.severidad}) en ${reposP.join(', ')}`.slice(0, 250);
      const cuerpo = [
        ...cuerpoDeFicha({ paquete: f.fi.escalares.paquete, sev: f.fi.escalares.severidad, noches: f.fi.escalares.noches,
          repos: reposP, avisos: f.fi.listas.avisos, id: idFicha }, { destino: 'issue' }),
        '',
        `@${respaldo.login} — aviso abierto por la revisión nocturna de dependencias del arnés. Asignado a @${asignado}: ${motivoDueno}.`,
        '',
        MARCA(idFicha),
      ].join('\n');
      if (simulado) {
        res.creados.push({ ficha: idFicha, proyecto: repo, id: null, asignado_a: asignado, motivo_dueno: motivoDueno, iteracion: null });
        textos.push({ proyecto: repo, ficha: idFicha, titulo, cuerpo });
        pedidoDelPaquete.set(clavePaquete(f, repo), { ficha: idFicha, id: null });
        continue;
      }
      let c;
      try {
        c = await plataforma('work-item.create', { repoDir, repo, title: titulo, description: cuerpo, tags: [ETIQUETA, `arnes:${idFicha}`],
          assignTo: asignado, forNight: true });
      } catch { c = null; }
      if (!(c && c.ok === true && c.value && Number.isInteger(c.value.id))) {
        const motivo = motivoPlataforma(c);
        fallo('crear', /HTTP 410/.test(motivo) ? `${repo} tiene los issues apagados o está archivado (${motivo})` : motivo);
        continue;
      }
      const n = c.value.id;
      pedidoDelPaquete.set(clavePaquete(f, repo), { ficha: idFicha, id: n });
      try { wi.anotarPedido(f.archivo, repo, n); }
      catch (e) { fallo('escribir-ficha', `el issue #${n} se creó pero no pude anotarlo en la ficha: ${e.message} — mañana se adopta por la etiqueta`); }
      if (!igual(c.value.assigned, asignado)) fallo('asignar', `el issue #${n} quedó sin asignar a ${asignado}: GitHub descarta en silencio a quien no tiene acceso al repo`);
      const faltan = Array.isArray(c.value.missingTags) ? c.value.missingTags : [ETIQUETA, `arnes:${idFicha}`];
      if (faltan.length) fallo('etiquetar', `el issue #${n} se creó sin la(s) etiqueta(s) ${faltan.join(', ')} (¿la identidad no puede crear etiquetas?): mañana no se lo encuentra por la etiqueta`);
      res.creados.push({ ficha: idFicha, proyecto: repo, id: n, asignado_a: asignado, motivo_dueno: motivoDueno, iteracion: null });
    }
  }

  avisos(ctx, res, comentar, respaldoDe);
  avisarCerradosVivos(ctx, res, comentar, respaldoDe, textos);

  const postergadasIds = new Set(postergadas.map((x) => x.ficha.idFicha));
  for (const x of pares.filter((y) => y.faltan.length || y.desconocidos.length)
    .sort((a, b) => String(a.ficha.idFicha).localeCompare(String(b.ficha.idFicha)))) {
    let faltan = x.faltan;
    if (simulado) {
      const saldria = new Set([...res.creados, ...res.adoptados].filter((y) => y.ficha === x.ficha.idFicha).map((y) => y.proyecto));
      faltan = faltan.filter((p) => !saldria.has(p));
    } else {
      try {
        const ya = new Set(leerPedidos(fs.readFileSync(x.ficha.archivo, 'utf8')).map((y) => y.proyecto));
        faltan = faltan.filter((p) => !ya.has(p));
      } catch { /* la ficha no se pudo releer: se informa con lo que se sabía */ }
    }
    if (!faltan.length && !x.desconocidos.length) continue;
    const partes = [];
    if (x.desconocidos.length) partes.push(`repo(s) fuera de repos.json: ${x.desconocidos.join(', ')} — sin repo de GitHub conocido, no se les pide`);
    if (postergadasIds.has(x.ficha.idFicha)) partes.push('postergada por el tope de la noche');
    partes.push(...faltan.map((repo) => {
      const suyo = res.fallidos.find((y) => y.ficha === x.ficha.idFicha && y.proyecto === repo && wi.isNoWorkItemStep(y.paso));
      return suyo ? `${faltan.length > 1 ? `${repo}: ` : ''}falló ${suyo.paso}: ${suyo.motivo}` : null;
    }).filter(Boolean));
    if (simulado && !partes.length) partes.push('modo simulado: no se crea nada');
    const desde = [x.ficha.fi.escalares.detectado, x.ficha.fi.escalares.reaparecido].filter(Boolean).sort().pop();
    const dias = desde ? diasEntre(desde, hoy) : NaN;
    if (faltan.length && dias >= DIAS_SIN_PEDIDO) partes.push(`sin issue en ${faltan.join(', ')} desde hace ${dias} días`);
    res.sin_pedido.push({ ficha: x.ficha.idFicha, proyectos: faltan, motivo: partes.join(' · ') || 'sin issue' });
  }
  for (const k of ['sin_pedido', 'pagados_avisados', 'deuda_avisada', 'reabiertos', 'cerrados_vivos_avisados', 'huerfanos_adoptados']) res[k].sort(porFicha);
  return { res, textos };
}

/**
 * «Ya no aparece» (con cierre), «volvió» (con reapertura) y «quedó declarada»: la misma regla que `avisos` de
 * work-items.js, con issues. Se miran TODAS las fichas con pedidos: la noche en que se resuelve es la noche en que ya no
 * aparece. Un repo sin medir no avisa nada: «no medido» nunca es «limpio».
 */
function avisos(ctx, res, comentar, respaldoDe) {
  const { gh, cfg, snap, hoy, simulado, fichas, ident } = ctx;
  if (!Array.isArray(snap.presencias)) return;
  const medidos = new Set((snap.repos || []).filter((r) => r.medido).map(etiqueta));
  const enConfig = new Set((cfg.repos || []).map(etiqueta));
  const prefijo = (ficha, repo, issue) => {
    const r = respaldoDe();
    if (!r.ok) res.fallidos.push({ ficha, proyecto: repo, paso: 'mencion', motivo: `el aviso salió sin mencionar al responsable de respaldo: ${r.motivo}` });
    const quienes = [];
    for (const a of (issue && Array.isArray(issue.assignees) ? issue.assignees : [])) if (a && a.login) quienes.push(a.login);
    if (r.ok && !quienes.some((l) => igual(l, r.login))) quienes.push(r.login);
    return quienes.length ? `${quienes.map((l) => `@${l}`).join(' ')} — ` : '';
  };
  for (const f of [...fichas].sort((a, b) => String(a.idFicha).localeCompare(String(b.idFicha)))) {
    const pedidos = leerPedidos(f.txt);
    if (!pedidos.length) continue;
    const paquete = String(f.fi.escalares.paquete || '').toLowerCase();
    for (const { proyecto: repo, id: n } of pedidos) {
      const reposP = (cfg.repos || []).filter((r) => proyectoDe(etiqueta(r), cfg) === repo);
      if (!reposP.length || !reposP.every((r) => r.activo !== false && medidos.has(etiqueta(r)))) continue;
      if ([...f.fi.listas.repos, ...(f.fi.listas.declarada_en || []).map(noc.soloRepo)].some((r) => r && !enConfig.has(r))) continue;
      const etiquetas = new Set(reposP.map(etiqueta));
      const presente = [];
      for (const p of snap.presencias || []) {
        const suya = f.ids.includes(p.id) || (paquete && String(p.paquete || '').toLowerCase() === paquete);
        if (suya) for (const x of p.repos || []) if (etiquetas.has(x.repo)) presente.push(x);
      }
      const fallo = (paso, motivo) => res.fallidos.push({ ficha: f.idFicha, proyecto: repo, paso, motivo });
      if (presente.length && !simulado) {
        const txt = fs.readFileSync(f.archivo, 'utf8');
        const pagados = listaDe(txt, 'pagado_avisado');
        const marca = pagados.find((l) => l.startsWith(`${repo} (`));
        const desde = marca && (marca.match(/^.* \((\d{4}-\d{2}-\d{2}), cerrado por el arnés\)$/) || [])[1];
        if (desde) {
          const b = leerSuIssue(gh, repo, n, f.idFicha);
          let texto = null;
          if (!b.ok) {
            fallo('reabrir', b.motivo);
            if (!b.ajeno && !b.borrado) texto = `Volvió a aparecer en este repo — medido el ${hoy}. No pude reabrirlo (${b.motivo}): reabrilo vos. Lo había cerrado la revisión nocturna el ${desde}.`;
          } else {
            const i = b.issue;
            const cerroElArnes = i.state === 'closed' && ident.ok && igual(i.closed_by && i.closed_by.login, ident.login)
              && String(i.closed_at || '').slice(0, 10) === desde;
            if (cerroElArnes) {
              const u = gh('PATCH', `repos/${repo}/issues/${n}`, { cuerpo: { state: 'open' }, valida: (v) => (v && v.state === 'open' ? null : 'la respuesta no dice que quedó abierto') });
              if (!u.ok) {
                fallo('reabrir', `no pude reabrir el issue #${n} (${u.motivo})`);
                texto = `${prefijo(f.idFicha, repo, i)}Volvió a aparecer en este repo — medido el ${hoy}. No pude reabrirlo (${u.motivo}): reabrilo vos. Lo había cerrado la revisión nocturna el ${desde}.`;
              } else {
                texto = `${prefijo(f.idFicha, repo, i)}Volvió a aparecer en este repo — medido el ${hoy}. Reabro este issue: lo había cerrado la revisión nocturna el ${desde}, cuando dejó de verla (ficha \`arnes:${f.idFicha}\`).`;
                res.reabiertos.push({ ficha: f.idFicha, proyecto: repo, id: n });
              }
            }
          }
          if (texto) {
            const k = comentar(repo, n, texto, f.idFicha);
            if (!k.ok) fallo('comentario', `no pude avisar en el issue #${n}: ${k.motivo}`);
          }
        }
        if (marca) {
          try { fs.writeFileSync(f.archivo, ponerLista(fs.readFileSync(f.archivo, 'utf8'), 'pagado_avisado', pagados.filter((l) => !l.startsWith(`${repo} (`)))); }
          catch (e) { fallo('escribir-ficha', `no pude borrar el «ya no aparece» de ${repo}: ${e.message}`); }
        }
      }
      let clave, linea, texto, entrada, lista;
      if (!presente.length) {
        clave = 'pagado_avisado'; linea = `${repo} (${hoy})`;
        if (listaDe(fs.readFileSync(f.archivo, 'utf8'), clave).some((l) => l.startsWith(`${repo} (`))) continue;
        entrada = { ficha: f.idFicha, proyecto: repo, id: n, cerrado: null, motivo_azure: null }; lista = res.pagados_avisados;
        let porque = null, noPude = null, issue = null;
        if (!simulado) {
          const b = leerSuIssue(gh, repo, n, f.idFicha);
          if (!b.ok) { fallo('cerrar', b.motivo); if (b.ajeno || b.borrado) continue; noPude = b.motivo; entrada.cerrado = false; }
          else {
            issue = b.issue;
            if (issue.state === 'closed') { entrada.cerrado = false; porque = 'ya-cerrado'; }
            else if (!abiertoPorArnes(issue, ident)) { entrada.cerrado = false; porque = ident.ok ? 'persona' : 'sin-identidad'; }
            else {
              const u = gh('PATCH', `repos/${repo}/issues/${n}`, { cuerpo: { state: 'closed', state_reason: 'completed' },
                valida: (v) => (v && v.state === 'closed' ? null : 'la respuesta no dice que quedó cerrado') });
              if (!u.ok) { fallo('cerrar', `no pude cerrar el issue #${n} (${u.motivo})`); noPude = u.motivo; entrada.cerrado = false; }
              else { entrada.cerrado = true; entrada.motivo_azure = 'completed'; }
            }
          }
        }
        const m = simulado ? '' : prefijo(f.idFicha, repo, issue);
        if (entrada.cerrado) linea = `${repo} (${hoy}, cerrado por el arnés)`;
        const pie = `La revisión nocturna de dependencias dejó de ver la vulnerabilidad, como alta o crítica, en \`main\` de este repo (ficha \`arnes:${f.idFicha}\`). Si vuelve a aparecer, se va a ver.`;
        texto = entrada.cerrado
          ? `${m}Ya no aparece — medido el ${hoy}. Cierro este issue: el arreglo está en \`main\`; cuándo llega a producción lo decide el equipo.\n\n${pie}`
          : noPude ? `${m}Ya no aparece — medido el ${hoy}. No pude cerrarlo (${noPude}): cerralo vos si corresponde.\n\n${pie}`
            : porque === 'ya-cerrado' ? `${m}Ya no aparece — medido el ${hoy}.\n\n${pie}`
              : `${m}Ya no aparece — medido el ${hoy}; cerralo si corresponde.\n\n${pie}`;
      } else if (presente.every((x) => x.declarada)) {
        const vence = presente.map((x) => x.vence || 'sin fecha').sort()[0];
        clave = 'deuda_avisada'; linea = `${repo} (vence ${vence})`;
        if (wi.yaMarcado(fs.readFileSync(f.archivo, 'utf8'), clave, linea)) continue;
        let m = '';
        if (!simulado) {
          const b = leerSuIssue(gh, repo, n, f.idFicha);
          if (!b.ok && (b.ajeno || b.borrado)) { fallo('comentario', b.motivo); continue; }
          m = prefijo(f.idFicha, repo, b.ok ? b.issue : null);
        }
        texto = `${m}Quedó declarada como deuda en este repo, vence ${vence}.\n\nMientras la declaración esté vigente la revisión nocturna no insiste; cuando venza vuelve a contar (ficha \`arnes:${f.idFicha}\`).`;
        entrada = { ficha: f.idFicha, proyecto: repo, id: n, vence }; lista = res.deuda_avisada;
      } else continue;
      if (!simulado) {
        const k = comentar(repo, n, texto, f.idFicha);
        if (!k.ok) { fallo('comentario', `no pude avisar en el issue #${n}: ${k.motivo}`); continue; }
        try { wi.marcar(f.archivo, clave, repo, linea); }
        catch (e) { fallo('escribir-ficha', `avisé en el issue #${n} pero no pude marcarlo: ${e.message}`); }
      }
      lista.push(entrada);
    }
  }
}

/** «Cerrado con la vulnerabilidad viva»: un comentario por episodio, sin reabrir (el nocturno decide `avisar`). */
function avisarCerradosVivos(ctx, res, comentar, respaldoDe, textos) {
  const { snap, hoy, simulado, fichas } = ctx;
  const c = snap && snap.cruce && typeof snap.cruce === 'object' ? snap.cruce : null;
  const lista = c && Array.isArray(c.cerrados_vivos) ? c.cerrados_vivos.filter((x) => x && typeof x === 'object' && x.avisar === true) : [];
  for (const x of [...lista].sort(porFicha)) {
    const fallo = (motivo) => res.fallidos.push({ ficha: x.ficha, proyecto: x.proyecto, paso: 'aviso-cerrado-vivo', motivo });
    const n = Number(x.pedido);
    if (!Number.isInteger(n)) { fallo(`el cruce no trae un pedido legible («${x.pedido}»)`); continue; }
    const f = fichas.find((y) => y.idFicha === x.ficha && y.estado !== 'archived');
    if (!f) { fallo(`la ficha ${x.ficha} no está viva en el disco`); continue; }
    let txt;
    try { txt = fs.readFileSync(f.archivo, 'utf8'); } catch (e) { fallo(`no pude leer la ficha: ${e.message}`); continue; }
    if (listaDe(txt, 'avisado_cerrado_vivo').some((l) => l.startsWith(`${x.proyecto} (`))) continue;
    const respaldo = respaldoDe();
    if (!respaldo.ok) { fallo(`sin la mención al responsable de respaldo no se avisa: ${respaldo.motivo}`); continue; }
    const repos = (Array.isArray(x.repos) && x.repos.length ? x.repos : ['(sin repos)']).map((r) => `\`${r}\``).join(', ');
    const paquete = `\`${f.fi.escalares.paquete || '(paquete desconocido)'}\``;
    const cuerpo = x.clase === 'no-aplica'
      ? `@${respaldo.login} — este issue está cerrado como no aplica desde el ${x.visto_cerrado || '?'}, y la vulnerabilidad ${paquete} sigue apareciendo en ${repos}, medido el ${hoy}.\n\nNo lo reabro: decidilo vos. La única salida sin arreglo es declarar la deuda en \`pending-vulnerabilities.json\`, con motivo y fecha de revisión: si no, va a seguir apareciendo todas las noches.`
      : `@${respaldo.login} — este issue está cerrado como arreglado desde el ${x.visto_cerrado || '?'}, y la vulnerabilidad ${paquete} sigue apareciendo en ${repos}, medido el ${hoy}.\n\nNo lo reabro: decidilo vos — se arregla (subir el paquete) o se declara la deuda en \`pending-vulnerabilities.json\`, con motivo y fecha de revisión.`;
    if (simulado) {
      textos.push({ tipo: 'aviso', proyecto: x.proyecto, ficha: x.ficha, id: n, comentario: cuerpo });
      res.cerrados_vivos_avisados.push({ ficha: x.ficha, proyecto: x.proyecto, id: n });
      continue;
    }
    const k = comentar(x.proyecto, n, cuerpo, x.ficha);
    if (!k.ok) { fallo(`no pude avisar en el issue #${n}: ${k.motivo}`); continue; }
    try { wi.marcar(f.archivo, 'avisado_cerrado_vivo', x.proyecto, `${x.proyecto} (${hoy})`); }
    catch (e) { res.fallidos.push({ ficha: x.ficha, proyecto: x.proyecto, paso: 'escribir-ficha', motivo: `avisé en el issue #${n} pero no pude marcarlo: ${e.message}` }); }
    res.cerrados_vivos_avisados.push({ ficha: x.ficha, proyecto: x.proyecto, id: n });
  }
}

// ── el estado de cada issue ────────────────────────────────────────────────────────────────────

/**
 * La última vez que una PERSONA tocó el issue: un evento de alguien que no es la identidad ni un `[bot]`,
 * o un comentario de la identidad SIN la marca. La creación cuenta si la hizo otra persona. Sin identidad conocida,
 * todo lo que no es un bot cuenta: ante la duda, «nadie la miró» no se afirma.
 */
function personaMasReciente(issue, linea, ident) {
  let mejor = null;
  const considerar = (login, tipo, cuando, cuerpo, esBot) => {
    if (!cuando || Number.isNaN(Date.parse(cuando))) return;
    if (esBot || /\[bot\]$/i.test(String(login || ''))) return;
    const delArnes = ident.ok && igual(login, ident.login);
    if (delArnes && !(tipo === 'commented' && !TIENE_MARCA.test(String(cuerpo || '')))) return;
    if (!mejor || Date.parse(cuando) > Date.parse(mejor.el)) mejor = { el: cuando, nombre: login || null };
  };
  if (issue && issue.user) considerar(issue.user.login, 'created', issue.created_at, issue.body, issue.user.type === 'Bot');
  for (const e of linea || []) {
    if (!e || typeof e !== 'object') continue;
    const quien = e.actor || e.user || {};
    considerar(quien.login, e.event, e.created_at || e.submitted_at, e.body, quien.type === 'Bot');
  }
  return mejor || { el: null, nombre: null };
}

const escribirJsonAtomico = (archivo, obj) => {
  fs.mkdirSync(path.dirname(archivo), { recursive: true });
  const tmp = `${archivo}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
  fs.renameSync(tmp, archivo);
};

function comandoGh() { return process.env.TYCON_GH_CMD || 'gh'; }
function chequearGh(cmd) {
  const [exe, pre] = /\.js$/i.test(cmd) ? [process.execPath, [cmd]] : [cmd, []];
  const v = spawnSync(exe, [...pre, '--version'], { encoding: 'utf8', timeout: 60000 });
  return v.error || v.status !== 0 ? `\`${cmd} --version\` no responde (${v.error ? v.error.message : `salió ${v.status}`})` : null;
}
const hayToken = () => !!(process.env.GH_TOKEN || process.env.GITHUB_TOKEN);

function volcar(a) {
  const hoy = a.hoy || new Date().toISOString().slice(0, 10);
  const destino = path.join(a.out, `bugs-${hoy}.json`);
  const noPudoVolcar = (motivo) => {
    try { escribirJsonAtomico(destino, { fecha: hoy, consultado: false, motivo, plataforma: 'github' }); }
    catch (e) { console.error(`🔴 estado de los issues: tampoco se pudo escribir ${destino}: ${e.message}`); }
    console.error(`🔴 estado de los issues: NO se pudo leer nada — ${motivo}`);
    console.error('   Esto es «no leído», no «coinciden»: el nocturno lo cobra como tal.');
    return 2;
  };
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(a.config, 'utf8')); } catch (e) { return noPudoVolcar(`no se pudo leer la configuración ${a.config}: ${e.message}`); }
  const mal = validarConfig(cfg);
  if (mal) return noPudoVolcar(mal);
  if (!hayToken()) return noPudoVolcar('sin credencial: GH_TOKEN está vacío');
  const cmd = comandoGh();
  const sinGh = chequearGh(cmd);
  if (sinGh) return noPudoVolcar(sinGh);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'estado-de-issues-'));
  try {
    const gh = crearGh({ cmd, tmp });
    const ident = leerIdentidad(gh, cfg);
    const todas = leerTodasLasFichas(a.pending);
    const pedidos = {};
    for (const f of todas.filter((x) => x.estado !== 'archived').sort((x, y) => String(x.idFicha).localeCompare(String(y.idFicha)))) {
      for (const { proyecto: repo, id: n } of leerPedidos(f.txt)) {
        const clave = noc.claveDePedido({ plataforma: 'github' }, repo, n);
        if (Object.prototype.hasOwnProperty.call(pedidos, clave)) continue;
        const e = { ficha: f.idFicha, proyecto: repo, leido: false, estado: null, categoria: null, motivo: null,
          estado_desde: null, cambiado_por_persona_el: null, cambiado_por_persona: null, motivo_no_leido: null };
        pedidos[clave] = e;
        if (!REPO.test(repo)) { e.motivo_no_leido = `«${repo}» no es un repo de GitHub`; continue; }
        const b = leerSuIssue(gh, repo, n, f.idFicha, { exigirEtiqueta: false });
        if (!b.ok) { e.motivo_no_leido = b.motivo; continue; }
        const linea = paginar(gh, `repos/${repo}/issues/${n}/timeline`);
        if (!linea.ok) { e.motivo_no_leido = `no pude leer la línea de tiempo (${linea.motivo})`; continue; }
        const p = personaMasReciente(b.issue, linea.valor, ident);
        Object.assign(e, { leido: true, estado: b.issue.state, categoria: categoriaDe(b.issue), motivo: b.issue.state_reason || null,
          estado_desde: b.issue.closed_at || b.issue.created_at || null, cambiado_por_persona_el: p.el, cambiado_por_persona: p.nombre });
      }
    }
    const nombrados = new Set(todas.flatMap((f) => leerPedidos(f.txt).map((x) => noc.claveDePedido({ plataforma: 'github' }, x.proyecto, x.id).toLowerCase())));
    const huerfanos = [], noConsultados = [];
    const repos = [...new Set((cfg.repos || []).map((r) => proyectoAzureDe(etiqueta(r), cfg)).filter((r) => r && REPO.test(r)))].sort();
    for (const repo of repos) {
      const r = issuesConEtiqueta(gh, repo, ETIQUETA);
      if (!r.ok) { noConsultados.push({ proyecto: repo, motivo: `no pude listar los issues del arnés (${r.motivo})` }); continue; }
      for (const i of r.valor.filter((x) => !nombrados.has(`${repo}#${x.number}`.toLowerCase())).sort((x, y) => x.number - y.number)) {
        const tok = etiquetasDe(i).find((x) => x.startsWith('arnes:'));
        huerfanos.push({ id: i.number, proyecto: repo, ficha: tok ? tok.slice('arnes:'.length) : null, estado: i.state, categoria: categoriaDe(i) });
      }
    }
    escribirJsonAtomico(destino, { fecha: hoy, consultado: true, motivo: null, plataforma: 'github', identidad: ident.ok ? ident.login : null,
      pedidos, huerfanos, huerfanos_no_consultados: noConsultados });
    const lista = Object.entries(pedidos);
    console.log(`Estado de los issues — ${hoy}`);
    if (!ident.ok) console.log(`⚠️ ${ident.motivo}`);
    console.log(`Issues leídos: ${lista.filter(([, x]) => x.leido).length} de ${lista.length}`);
    for (const [k, x] of lista.filter(([, y]) => !y.leido)) console.log(`🚧 NO LEÍDO ${k} (${x.ficha}): ${x.motivo_no_leido}`);
    for (const x of huerfanos) console.log(`🧷 issue suelto ${x.proyecto}#${x.id} (ficha ${x.ficha || 'sin etiqueta'}): ninguna ficha lo nombra`);
    for (const x of noConsultados) console.log(`🚧 ${x.proyecto}: ${x.motivo} — no se puede decir que no haya issues sueltos`);
    return 0;
  } catch (e) {
    if (e instanceof NoSePuedeIntentar) return noPudoVolcar(e.message);
    throw e;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function noPudo(motivo) {
  console.error(`🔴 issues: NO se pudo intentar nada — ${motivo}`);
  console.error('   Esto es «no medido», no «nada que pedir»: no se escribió la sección `pedidos`.');
  return 2;
}

function leerVolcadoDeHoy(outDir, hoy) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(outDir, `bugs-${hoy}.json`), 'utf8'));
    return v && typeof v === 'object' && v.consultado === true && v.plataforma === 'github' ? v : null;
  } catch { return null; }
}

async function correr(a) {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(a.config, 'utf8')); } catch (e) { return noPudo(`no se pudo leer la configuración ${a.config}: ${e.message}`); }
  const mal = validarConfig(cfg);
  if (mal) return noPudo(mal);
  const hoy = a.hoy || new Date().toISOString().slice(0, 10);
  const archSnap = path.join(a.out, `dependencias-${hoy}.json`);
  if (!fs.existsSync(archSnap)) return noPudo(`no está el snapshot de hoy (${archSnap}): la revisión no corrió o no escribió`);
  let snap;
  try { snap = JSON.parse(fs.readFileSync(archSnap, 'utf8')); } catch (e) { return noPudo(`el snapshot de hoy es ilegible: ${e.message}`); }
  if (!hayToken()) return noPudo('sin credencial: GH_TOKEN está vacío');
  const cmd = comandoGh();
  const sinGh = chequearGh(cmd);
  if (sinGh) return noPudo(sinGh);
  const pres = cfg.presupuesto_de_ruido || {};
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'issues-'));
  const ctx = {
    cfg, hoy, snap, out: a.out, simulado: a.simular || !(cfg.github && cfg.github.issues_enabled === true),
    tope: Number.isInteger(pres.tope_pr_por_noche) ? pres.tope_pr_por_noche : 2,
    fichas: leerTodasLasFichas(a.pending), volcado: leerVolcadoDeHoy(a.out, hoy), responsables: responsables(a), avisosDeSalida: [],
    repoDir: path.dirname(path.resolve(a.operations)),
  };
  let resultado;
  try {
    ctx.gh = crearGh({ cmd, tmp });
    ctx.ident = leerIdentidad(ctx.gh, cfg);
    resultado = await hablar(ctx);
  } catch (e) { if (e instanceof NoSePuedeIntentar) return noPudo(e.message); throw e; }
  finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  const actual = JSON.parse(fs.readFileSync(archSnap, 'utf8'));
  actual.pedidos = resultado.res;
  const tmpSnap = `${archSnap}.${process.pid}.tmp`;
  fs.writeFileSync(tmpSnap, `${JSON.stringify(actual, null, 2)}\n`);
  fs.renameSync(tmpSnap, archSnap);
  for (const m of ctx.avisosDeSalida) console.error(`⚠️ issues: ${m}`);
  if (a.json) console.log(JSON.stringify(resultado.res, null, 2));
  else imprimir(resultado.res, resultado.textos, hoy);
  return 0;
}

function imprimir(r, textos, hoy) {
  console.log(`Issues de dependencias — ${hoy}`);
  if (r.simulado) console.log('🟡 MODO SIMULADO: se leyó GitHub y se calculó lo que habría salido. No se creó ni se comentó nada, y las fichas no se tocaron (se prende con github.issues_enabled).');
  console.log(`Fichas vivas: ${r.fichas_vivas} · sin issue en algún repo: ${r.fichas_sin_pedido} · tope: ${r.tope} ficha(s) por noche · issues que ya existían: ${r.existentes}`);
  for (const c of r.creados) console.log(`${r.simulado ? '🟡 habría creado' : '🆕 creado'} en ${c.proyecto} (ficha ${c.ficha})${c.id ? ` → #${c.id}` : ''} · asignado a ${c.asignado_a} (${c.motivo_dueno})`);
  for (const x of r.adoptados) console.log(`🔗 adoptado en ${x.proyecto} (ficha ${x.ficha}) → #${x.id}: GitHub ya lo tenía por la etiqueta`);
  for (const x of r.fallidos) console.log(`❌ ${x.paso} · ${x.proyecto} (ficha ${x.ficha}): ${x.motivo}`);
  for (const x of r.postergados) console.log(`⏳ postergada por el tope: ${x.ficha} (${x.proyectos.join(', ')}) — entra primero mañana`);
  for (const x of r.reabiertos) console.log(`🔁 volvió a aparecer en ${x.proyecto}: #${x.id} reabierto (ficha ${x.ficha})`);
  for (const x of r.pagados_avisados) console.log(`📣 «ya no aparece» en ${x.proyecto} (#${x.id}, ficha ${x.ficha})${x.cerrado === true ? ' · issue cerrado' : x.cerrado === false ? ' · no lo cerré' : ''}`);
  for (const x of r.deuda_avisada) console.log(`📣 «quedó declarada, vence ${x.vence}» en ${x.proyecto} (#${x.id}, ficha ${x.ficha})`);
  for (const x of r.sin_pedido) console.log(`🚧 sigue sin issue: ${x.ficha} en ${x.proyectos.join(', ')} — ${x.motivo}`);
  for (const x of r.cerrados_vivos_avisados) console.log(`${r.simulado ? '🟡 habría avisado' : '📣 avisado'} «cerrado con la vulnerabilidad viva» en ${x.proyecto} (#${x.id}, ficha ${x.ficha}) — no se reabre`);
  for (const x of r.huerfanos_adoptados) console.log(`${r.simulado ? '🟡 habría adoptado' : '🧷 adoptado'} el issue suelto ${x.proyecto}#${x.id} → ficha ${x.ficha}`);
  for (const x of r.huerfanos_sin_adoptar) console.log(`🚧 issue suelto ${x.proyecto}#${x.id} sin adoptar: ${x.motivo}`);
  if (textos.length) {
    console.log('\n--- el texto de lo que habría salido ---');
    for (const t of textos) {
      console.log(`\n## ${t.proyecto} · ficha ${t.ficha}${t.tipo === 'aviso' ? ` · comentario en #${t.id}` : ''}`);
      if (t.titulo) console.log(`Título: ${t.titulo}`);
      console.log(t.cuerpo || t.comentario);
    }
  }
}

const AYUDA = `github-issues.js — el aviso de dependencias como issue de GitHub (un issue por ficha y repo).

  run     por cada ficha viva sin issue en alguno de sus repos: lo busca por su etiqueta, y si no está lo crea en el
          repo del producto, asignado al responsable de operations.json. Avisa «ya no aparece» (y cierra lo suyo),
          «volvió» (y reabre lo suyo), «quedó declarada» y «cerrado con la vulnerabilidad viva». Agrega la sección
          «pedidos» al snapshot de hoy.
  state   vuelca a <out>/bugs-<hoy>.json el estado de cada issue de las fichas y los issues del arnés que ninguna ficha
          nombra. Sólo lee.

  --config <f>     repos.json (entradas con «github: <dueño>/<repo>»; bloque «github»: issues_enabled, identity)
  --operations <f> operations.json (owners.default: respaldo y mención; owners.by_project["<dueño>/<repo>"])
  --pending <dir>  dónde están las fichas · --out <dir> dónde está el snapshot · --today <fecha> · --simulate · --json

Habla con GitHub por TYCON_GH_CMD (por defecto gh) y necesita GH_TOKEN.
Exit: 0 habló con GitHub · 2 no pudo intentar nada.`;

function main(argv = process.argv) {
  const a = wi.parseArgs(argv);
  if (a.error) { console.error(`error: ${a.error}\n\n${AYUDA}`); return 2; }
  if (a.cmd === 'run') return correr(a);
  if (a.cmd === 'state') return volcar(a);
  console.log(AYUDA);
  return a.cmd === 'help' ? 0 : 2;
}

if (require.main === module) {
  Promise.resolve(main()).then((c) => { process.exitCode = c; }, (e) => { console.error(e && e.stack ? e.stack : String(e)); process.exitCode = 1; });
}

module.exports = { main, crearGh, paginar, issuesConEtiqueta, leerSuIssue, abiertoPorArnes, categoriaDe, leerIdentidad,
  responsables, validarConfig, personaMasReciente, hablar, correr, volcar, MARCA };
