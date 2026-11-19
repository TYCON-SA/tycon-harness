#!/usr/bin/env node
/**
 * gate-adoption.js — en qué repos la rama principal exige el portón de CI, en cuáles no y en cuáles no se pudo medir.
 *
 * POR QUÉ EXISTE. El portón de CI (`scripts/ci/tycon-ci-gate.js`) es opt-in por repo: sin su compilación, o sin la
 * política de rama que la exige, un repo no tiene red del servidor, y eso no da ningún error. Esto mira la plataforma
 * cada noche y cuenta, repo por repo, dónde está exigido y dónde no.
 *
 * QUÉ MIRA, por API REST y sin clonar:
 *   · azure: los repos de cada proyecto; por repo, las compilaciones (`build/definitions`) cuyo YAML
 *     (`process.yamlFilename`, leído por la API de ítems) nombra `tycon-ci-gate.js`, y las políticas de la rama
 *     principal: una política de compilación habilitada y bloqueante que apunta a una de esas definiciones, con un
 *     alcance exacto, de prefijo o de «rama principal» que cubre la rama, la exige.
 *   · github: los repos de la organización; por repo, los flujos de `.github/workflows/` que nombran el portón, y el
 *     control requerido de la rama principal: primero las reglas de la rama (se leen sin ser administrador), después la
 *     protección (pide administrador). El control requerido es el `name:` de un trabajo, o su clave, en el flujo que
 *     nombra el portón; con matriz, `gate (…)`; desde un flujo reutilizable, `<trabajo que llama> / gate`.
 *
 * LOS ESTADOS
 *   requerido              la rama exige una compilación cuyo YAML nombra el portón
 *   requerido-con-escape   lo mismo, y ese YAML trae `continueOnError: true`, `continue-on-error: true` o `|| true` en
 *                          una línea que no es comentario. No separa pasos: un escape en otro paso del mismo YAML cuenta
 *   pipeline-sin-política  hay una compilación cuyo YAML lo nombra y la rama no la exige
 *   sin-portón             ningún YAML lo nombra
 *   no-aplica              repo vacío, archivado o deshabilitado, o sin rama principal
 *   no-medido              la API contestó un error, un 403 o no contestó, o un YAML no se pudo leer
 *
 * 🔴 `requerido` no prueba que el portón corra de verdad: dice que la rama exige una compilación cuyo YAML lo nombra. No
 * mira si la definición de la compilación está habilitada (Azure da `queueStatus`, que nadie verificó contra una
 * organización real) ni si el paso que lo nombra se ejecuta.
 *
 * 🔴 No medido no es «sin portón». Una lectura que falla deja ese repo en `no-medido` con el motivo, y el guion sale 1.
 * Si falla la lista de repos, o una de sus páginas (las recorre todas: Azure con `x-ms-continuationtoken`, GitHub con
 * el encabezado `Link`), la línea sale `?`: una lista incompleta no se cuenta. Sin la credencial de la plataforma no se
 * pregunta nada y la línea sale `?`: sin ella, GitHub lista sólo los repos públicos y la cuenta parecería completa.
 *
 * 🔴 La cuenta es la de los repos que la credencial ve: una credencial sin alcance sobre los repos privados los deja
 * afuera sin error, y eso no se puede detectar desde la API.
 *
 * LO QUE ESCRIBE: `--out` lleva una sola línea, sólo con números (la pega el resumen diario, que sale a un servicio de
 * afuera): `Portón de CI (repos): requerido N · con escape N · pipeline sin política N · sin portón N · no aplica N ·
 * no medido N`, o `Portón de CI (repos): ?`. El detalle por repo, con su motivo, va a la salida estándar, que queda en
 * el registro del pipeline. No nombra repos ni organizaciones: los recibe como argumentos.
 *
 * USO
 *   node gate-adoption.js azure --org <url> --project <p>[,<p>…] [--branch <rama>] [--out <archivo>]
 *   node gate-adoption.js github --org <organización> [--branch <rama>] [--out <archivo>]
 *   node gate-adoption.js juntar --out <archivo> <línea de una plataforma>…
 *   Sin --branch se mide la rama principal de cada repo; una rama pedida que el repo no tiene es `no-aplica`. `juntar`
 *   suma las líneas de cada plataforma en una sola para el resumen: si a una le falta la suya, o salió «?», sale «?».
 *   Credenciales sólo por ambiente, nunca en argumentos ni en la salida: AZURE_DEVOPS_EXT_PAT (Azure),
 *   GH_TOKEN o GITHUB_TOKEN (GitHub). TYCON_GITHUB_API: la dirección base de la API de GitHub (por defecto
 *   https://api.github.com).
 *
 * SALIDA: 0 todos los repos medidos · 1 alguno no medido, o la lista no se pudo leer entera · 2 uso
 */
'use strict';

const fs = require('fs');

const ESPERA_MS = 30000;
const MAX_PAGINAS = 100;
const API_AZURE = 'api-version=7.1';
const PORTON = 'tycon-ci-gate.js';

class NoSePudo extends Error {}

const recortar = (t, n = 160) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, n) || '(sin salida)';
// texto de afuera antes de imprimirlo: Azure interpreta `##vso[…]` en cualquier línea del registro
const limpio = (t, n) => recortar(String(t || '').replace(/#{2,}/g, '#'), n);

async function pedir(url, headers, quien) {
  const corte = new AbortController();
  const reloj = setTimeout(() => corte.abort(), ESPERA_MS);
  let r;
  let texto;
  // el cuerpo se lee dentro del mismo tope: una respuesta cortada o colgada a la mitad es «no contestó», no un error
  // que tire el guion entero
  try {
    r = await fetch(url, { signal: corte.signal, headers });
    texto = await r.text();
  } catch (e) {
    throw new NoSePudo(`la API de ${quien} no contestó (${e.name === 'AbortError' ? 'pasaron 30 s' : e.code || (e.cause && e.cause.code) || e.message})`);
  } finally { clearTimeout(reloj); }
  if (r.status === 404) return { status: 404, doc: null, headers: r.headers };
  if (!r.ok) throw new NoSePudo(`la API de ${quien} contestó ${r.status} en ${new URL(url).pathname}: ${limpio(texto, 100)}`);
  try { return { status: r.status, doc: JSON.parse(texto), headers: r.headers }; } catch (_) { throw new NoSePudo(`la API de ${quien} contestó algo que no es JSON en ${new URL(url).pathname}`); }
}

// --- el texto del YAML -------------------------------------------------------------------------------------------------

/** La línea sin su comentario: un `#` al principio o después de un espacio, fuera de comillas. */
function sinComentario(l) {
  let comilla = null;
  for (let k = 0; k < l.length; k++) {
    const c = l[k];
    if (comilla) { if (c === comilla) comilla = null; continue; }
    if (c === '"' || c === "'") comilla = c;
    else if (c === '#' && (k === 0 || /\s/.test(l[k - 1]))) return l.slice(0, k);
  }
  return l;
}
const lineasSinComentario = (texto) => String(texto).split('\n').map(sinComentario);
/** ¿El YAML nombra el portón en una línea que no es comentario? */
function nombraElPorton(texto) { return lineasSinComentario(texto).some((l) => l.includes(PORTON)); }
/** ¿El YAML trae un escape (`continueOnError: true`, `continue-on-error: true`, `|| true`) fuera de un comentario? */
function tieneEscape(texto) {
  return lineasSinComentario(texto).some((l) => /\b(continueOnError|continue-on-error):\s*(["']?)true\2(\s|$)|\|\|\s*true\b/.test(l));
}
const sangria = (l) => /^ */.exec(l)[0].length;
/**
 * Los nombres con que GitHub puede llamar al control de un trabajo: las claves de `jobs:` (con la sangría que tenga el
 * archivo) y el `name:` de cada trabajo. El `name:` del flujo o el de un paso no son nombres de trabajo.
 */
function nombresDeTrabajos(texto) {
  const nombres = new Set();
  const lineas = lineasSinComentario(texto);
  const i = lineas.findIndex((l) => /^jobs:\s*$/.test(l));
  if (i === -1) return nombres;
  let deTrabajo = null;
  let deCampo = null;
  for (let j = i + 1; j < lineas.length; j++) {
    const l = lineas[j];
    if (!l.trim()) continue;
    if (/^\S/.test(l)) break;
    const n = sangria(l);
    if (deTrabajo === null) deTrabajo = n;
    if (n === deTrabajo) {
      const m = /^\s*([A-Za-z0-9_-]+):\s*$/.exec(l);
      if (m) nombres.add(m[1]);
      deCampo = null;
      continue;
    }
    if (n < deTrabajo) break;
    if (deCampo === null) deCampo = n;
    if (n === deCampo) {
      const m = /^\s*name:\s*["']?([^"'\n]+?)["']?\s*$/.exec(l);
      if (m) nombres.add(m[1]);
    }
  }
  return nombres;
}
/**
 * ¿El contexto requerido es el de alguno de estos trabajos? GitHub lo llama por el nombre del trabajo; con matriz,
 * `gate (ubuntu-latest)`; desde un flujo reutilizable, `<trabajo que llama> / gate`.
 */
function esDelTrabajo(contexto, nombres) {
  return [...nombres].some((n) => contexto === n || contexto.startsWith(`${n} (`)
    || contexto.endsWith(` / ${n}`) || contexto.includes(` / ${n} (`));
}

// --- Azure DevOps ------------------------------------------------------------------------------------------------------

function cabecerasAzure() {
  const pat = process.env.AZURE_DEVOPS_EXT_PAT || '';
  if (!pat) throw new NoSePudo('falta AZURE_DEVOPS_EXT_PAT en el ambiente');
  return { accept: 'application/json', authorization: `Basic ${Buffer.from(`:${pat}`).toString('base64')}` };
}

/** Todas las páginas de una lista de Azure (`value`), siguiendo `x-ms-continuationtoken`. Tira NoSePudo si alguna falla. */
async function listaAzure(url, headers) {
  const todos = [];
  let token = null;
  for (let pagina = 0; ; pagina += 1) {
    if (pagina >= MAX_PAGINAS) throw new NoSePudo(`más de ${MAX_PAGINAS} páginas: no las leí todas`);
    const u = new URL(url);
    if (token) u.searchParams.set('continuationToken', token);
    const r = await pedir(u.href, headers, 'Azure DevOps');
    if (r.status === 404 || !r.doc || !Array.isArray(r.doc.value)) throw new NoSePudo(`la respuesta no trae la lista (value) en ${u.pathname}`);
    todos.push(...r.doc.value);
    token = r.headers.get('x-ms-continuationtoken');
    if (!token) return todos;
  }
}

/** ¿El alcance de una política cubre esta rama? Exacto, por prefijo, o «la rama principal» del repo. */
function alcanceCubre(s, ref, repo) {
  if (!s || (s.repositoryId && s.repositoryId !== repo.id)) return false;
  const tipo = String(s.matchKind || 'exact').toLowerCase();
  if (tipo === 'prefix') return typeof s.refName === 'string' && ref.startsWith(s.refName);
  if (tipo === 'defaultbranch') return ref === repo.defaultBranch;
  return s.refName === ref;
}

async function estadoAzure({ base, repo, branch, headers }) {
  if (repo.isDisabled) return { estado: 'no-aplica', motivo: 'deshabilitado' };
  if (!repo.defaultBranch || repo.size === 0) return { estado: 'no-aplica', motivo: 'vacío o sin rama principal' };
  // sin --branch, la rama principal de cada repo; una rama pedida que no existe es «no aplica», como en GitHub
  const rama = branch || String(repo.defaultBranch).replace(/^refs\/heads\//, '');
  const ref = `refs/heads/${rama}`;
  try {
    if (ref !== repo.defaultBranch) {
      const ramas = await listaAzure(`${base}/git/repositories/${encodeURIComponent(repo.id)}/refs?filter=${encodeURIComponent(`heads/${rama}`)}&${API_AZURE}`, headers);
      if (!ramas.some((x) => x && x.name === ref)) return { estado: 'no-aplica', motivo: `sin rama ${rama}` };
    }
    const defs = await listaAzure(`${base}/build/definitions?repositoryId=${encodeURIComponent(repo.id)}&repositoryType=TfsGit&includeAllProperties=true&${API_AZURE}`, headers);
    const conPorton = [];
    let ilegible = null;
    for (const d of defs) {
      const yaml = d && d.process && d.process.yamlFilename;
      if (!yaml) continue;
      try {
        const r = await pedir(`${base}/git/repositories/${encodeURIComponent(repo.id)}/items?path=${encodeURIComponent(yaml)}&includeContent=true&${API_AZURE}`, headers, 'Azure DevOps');
        if (r.status === 404 || !r.doc || typeof r.doc.content !== 'string') { ilegible = `no pude leer ${yaml} de la compilación ${d.id}`; continue; }
        if (nombraElPorton(r.doc.content)) conPorton.push({ id: Number(d.id), escape: tieneEscape(r.doc.content) });
      } catch (e) {
        if (!(e instanceof NoSePudo)) throw e;
        ilegible = `no pude leer ${yaml} de la compilación ${d.id}: ${e.message}`;
      }
    }
    if (!conPorton.length) return ilegible ? { estado: 'no-medido', motivo: ilegible } : { estado: 'sin-portón', motivo: `${defs.length} compilación(es), ninguna nombra el portón` };
    const pol = await pedir(`${base}/policy/configurations?repositoryId=${encodeURIComponent(repo.id)}&refName=${encodeURIComponent(ref)}&${API_AZURE}`, headers, 'Azure DevOps');
    if (pol.status === 404 || !pol.doc || !Array.isArray(pol.doc.value)) throw new NoSePudo('la lista de políticas no es una lista');
    const exige = (c) => pol.doc.value.some((p) => p && p.isEnabled === true && p.isBlocking === true && p.settings
      && Number(p.settings.buildDefinitionId) === c.id
      && (!Array.isArray(p.settings.scope) || p.settings.scope.some((s) => alcanceCubre(s, ref, repo))));
    const exigidas = conPorton.filter(exige);
    if (exigidas.length) {
      return exigidas.some((c) => !c.escape)
        ? { estado: 'requerido', motivo: `compilación ${exigidas.find((c) => !c.escape).id} exigida` }
        : { estado: 'requerido-con-escape', motivo: `compilación ${exigidas[0].id} exigida, con un escape en su YAML` };
    }
    if (ilegible) return { estado: 'no-medido', motivo: ilegible };
    return { estado: 'pipeline-sin-política', motivo: `compilación ${conPorton[0].id} nombra el portón y la rama ${rama} no la exige` };
  } catch (e) {
    if (!(e instanceof NoSePudo)) throw e;
    return { estado: 'no-medido', motivo: e.message };
  }
}

async function medirAzure({ org, projects, branch }) {
  const headers = cabecerasAzure();
  const repos = [];
  for (const project of projects) {
    const base = `${String(org).replace(/\/+$/, '')}/${encodeURIComponent(project)}/_apis`;
    let lista;
    try { lista = await listaAzure(`${base}/git/repositories?${API_AZURE}`, headers); } catch (e) {
      if (!(e instanceof NoSePudo)) throw e;
      return { listaCompleta: false, motivo: `proyecto ${project}: ${e.message}`, repos };
    }
    for (const repo of lista) repos.push({ nombre: `${project}/${repo.name}`, ...(await estadoAzure({ base, repo, branch, headers })) });
  }
  return { listaCompleta: true, repos };
}

// --- GitHub ------------------------------------------------------------------------------------------------------------

function cabecerasGithub() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
  // sin credencial la API lista sólo los repos públicos: la cuenta parecería completa sin serlo
  if (!token) throw new NoSePudo('falta GH_TOKEN (o GITHUB_TOKEN) en el ambiente');
  return { accept: 'application/vnd.github+json', 'user-agent': 'gate-adoption', 'x-github-api-version': '2022-11-28', authorization: `Bearer ${token}` };
}

const siguiente = (link) => { const m = /<([^>]+)>;\s*rel="next"/.exec(link || ''); return m ? m[1] : null; };

/** Los contextos requeridos de la rama, o null si no se pudo saber. Lanza NoSePudo con el motivo. */
async function controlesRequeridos({ api, org, nombre, rama, headers }) {
  const base = `${api}/repos/${org}/${encodeURIComponent(nombre)}`;
  const contextos = new Set();
  const reglas = await pedir(`${base}/rules/branches/${encodeURIComponent(rama)}`, headers, 'GitHub');
  if (reglas.status !== 404) {
    if (!Array.isArray(reglas.doc)) throw new NoSePudo('las reglas de la rama no son una lista');
    for (const r of reglas.doc) {
      if (r && r.type === 'required_status_checks' && r.parameters) for (const c of r.parameters.required_status_checks || []) if (c && c.context) contextos.add(c.context);
    }
  }
  let prot;
  try { prot = await pedir(`${base}/branches/${encodeURIComponent(rama)}/protection`, headers, 'GitHub'); } catch (e) {
    if (!(e instanceof NoSePudo)) throw e;
    return { contextos, protecionIlegible: /contestó 403/.test(e.message) ? 'la protección de la rama pide permiso de administrador' : e.message };
  }
  if (prot.status !== 404 && prot.doc && prot.doc.required_status_checks) {
    const rsc = prot.doc.required_status_checks;
    for (const c of rsc.contexts || []) contextos.add(c);
    for (const c of rsc.checks || []) if (c && c.context) contextos.add(c.context);
  }
  return { contextos, protecionIlegible: null };
}

async function estadoGithub({ api, org, repo, branch, headers }) {
  if (repo.archived) return { estado: 'no-aplica', motivo: 'archivado' };
  const rama = branch || repo.default_branch;
  if (!repo.default_branch || repo.size === 0) return { estado: 'no-aplica', motivo: 'vacío o sin rama principal' };
  const base = `${api}/repos/${org}/${encodeURIComponent(repo.name)}`;
  try {
    const b = await pedir(`${base}/branches/${encodeURIComponent(rama)}`, headers, 'GitHub');
    if (b.status === 404) return { estado: 'no-aplica', motivo: `sin rama ${rama}` };
    const dir = await pedir(`${base}/contents/.github/workflows`, headers, 'GitHub');
    const archivos = dir.status === 404 ? [] : dir.doc;
    if (!Array.isArray(archivos)) throw new NoSePudo('la carpeta de flujos no es una lista');
    const conPorton = [];
    for (const f of archivos.filter((x) => x && x.type === 'file' && /\.ya?ml$/.test(x.name))) {
      const a = await pedir(`${base}/contents/.github/workflows/${encodeURIComponent(f.name)}`, headers, 'GitHub');
      if (a.status === 404 || !a.doc || typeof a.doc.content !== 'string') throw new NoSePudo(`no pude leer .github/workflows/${f.name}`);
      const texto = Buffer.from(a.doc.content, a.doc.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8');
      if (nombraElPorton(texto)) conPorton.push({ nombre: f.name, escape: tieneEscape(texto), trabajos: nombresDeTrabajos(texto) });
    }
    if (!conPorton.length) return { estado: 'sin-portón', motivo: `${archivos.length} flujo(s), ninguno nombra el portón` };
    const { contextos, protecionIlegible } = await controlesRequeridos({ api, org, nombre: repo.name, rama, headers });
    const exigidos = conPorton.filter((f) => [...contextos].some((c) => esDelTrabajo(c, f.trabajos)));
    if (exigidos.length) {
      return exigidos.some((f) => !f.escape)
        ? { estado: 'requerido', motivo: `${exigidos.find((f) => !f.escape).nombre} es control requerido` }
        : { estado: 'requerido-con-escape', motivo: `${exigidos[0].nombre} es control requerido, con un escape en su YAML` };
    }
    if (protecionIlegible) return { estado: 'no-medido', motivo: protecionIlegible };
    // sin el nombre del trabajo (`jobs:` en forma de flujo, un nombre armado por expresión) no se sabe si la rama lo exige
    const sinNombre = conPorton.find((f) => !f.trabajos.size || [...f.trabajos].some((n) => n.includes('${{')));
    if (sinNombre) return { estado: 'no-medido', motivo: `no pude sacar el nombre del trabajo de ${sinNombre.nombre}` };
    return { estado: 'pipeline-sin-política', motivo: `${conPorton[0].nombre} nombra el portón y la rama ${rama} no lo exige` };
  } catch (e) {
    if (!(e instanceof NoSePudo)) throw e;
    return { estado: 'no-medido', motivo: e.message };
  }
}

async function medirGithub({ org, branch, api = process.env.TYCON_GITHUB_API || 'https://api.github.com' }) {
  const headers = cabecerasGithub();
  const raiz = String(api).replace(/\/+$/, '');
  const lista = [];
  let url = `${raiz}/orgs/${encodeURIComponent(org)}/repos?per_page=100&page=1`;
  try {
    for (let pagina = 0; url; pagina += 1) {
      if (pagina >= MAX_PAGINAS) throw new NoSePudo(`más de ${MAX_PAGINAS} páginas: no las leí todas`);
      const r = await pedir(url, headers, 'GitHub');
      if (r.status === 404 || !Array.isArray(r.doc)) throw new NoSePudo('la lista de repos no es una lista');
      lista.push(...r.doc);
      url = siguiente(r.headers.get('link'));
    }
  } catch (e) {
    if (!(e instanceof NoSePudo)) throw e;
    return { listaCompleta: false, motivo: e.message, repos: [] };
  }
  const repos = [];
  for (const repo of lista) repos.push({ nombre: repo.name, ...(await estadoGithub({ api: raiz, org, repo, branch, headers })) });
  return { listaCompleta: true, repos };
}

// --- la línea y el uso ---------------------------------------------------------------------------------------------------

const ORDEN = [['requerido', 'requerido'], ['requerido-con-escape', 'con escape'], ['pipeline-sin-política', 'pipeline sin política'], ['sin-portón', 'sin portón'], ['no-aplica', 'no aplica'], ['no-medido', 'no medido']];

/** La línea del resumen: sólo números, o `?` si la lista de repos no se leyó entera. */
function linea(res) {
  if (!res || !res.listaCompleta) return 'Portón de CI (repos): ?';
  const n = (estado) => res.repos.filter((r) => r.estado === estado).length;
  return `Portón de CI (repos): ${ORDEN.map(([e, palabra]) => `${palabra} ${n(e)}`).join(' · ')}`;
}

/**
 * Una sola línea para el resumen con lo de cada plataforma: suma sus números. Si una no dejó su línea, o la dejó con «?»
 * o con otra forma, la suma sale «?»: una plataforma sin medir no se cuenta como cero.
 */
function juntarLineas(textos) {
  const total = Object.fromEntries(ORDEN.map(([e]) => [e, 0]));
  for (const t of textos) {
    const l = String(t || '').split('\n')[0].trim();
    const m = new RegExp(`^Portón de CI \\(repos\\): ${ORDEN.map(([, palabra]) => `${palabra} (\\d+)`).join(' · ')}$`).exec(l);
    if (!m) return 'Portón de CI (repos): ?';
    ORDEN.forEach(([e], i) => { total[e] += Number(m[i + 1]); });
  }
  if (!textos.length) return 'Portón de CI (repos): ?';
  return `Portón de CI (repos): ${ORDEN.map(([e, palabra]) => `${palabra} ${total[e]}`).join(' · ')}`;
}

function juntar(argv) {
  if (argv[0] !== '--out' || !argv[1] || argv.length < 3) {
    console.error('uso: gate-adoption.js juntar --out <archivo> <línea de una plataforma>…');
    return 2;
  }
  const textos = argv.slice(2).map((f) => { try { return fs.readFileSync(f, 'utf8'); } catch (_) { return null; } });
  const l = juntarLineas(textos);
  fs.writeFileSync(argv[1], `${l}\n`);
  console.log(l);
  return l.endsWith(': ?') ? 1 : 0;
}

function parseArgs(argv) {
  const plataforma = argv[0];
  if (plataforma !== 'azure' && plataforma !== 'github') return null;
  // sin --branch se mide la rama principal de cada repo
  const a = { plataforma, branch: undefined };
  for (let i = 1; i < argv.length; i++) {
    const v = argv[i + 1];
    if (argv[i] === '--org') { a.org = v; i++; } else if (argv[i] === '--project') { a.projects = String(v || '').split(',').map((s) => s.trim()).filter(Boolean); i++; } else if (argv[i] === '--branch') { a.branch = v; i++; } else if (argv[i] === '--out') { a.out = v; i++; } else return null;
  }
  if (!a.org || (plataforma === 'azure' && !(a.projects && a.projects.length))) return null;
  return a;
}

async function main(argv) {
  if (argv[0] === 'juntar') return juntar(argv.slice(1));
  const a = parseArgs(argv);
  if (!a) {
    console.error('uso: gate-adoption.js azure --org <url> --project <p>[,<p>…] [--branch <rama>] [--out <archivo>]\n     gate-adoption.js github --org <organización> [--branch <rama>] [--out <archivo>]\n     gate-adoption.js juntar --out <archivo> <línea de una plataforma>…');
    return 2;
  }
  let res;
  try {
    res = a.plataforma === 'azure' ? await medirAzure({ org: a.org, projects: a.projects, branch: a.branch }) : await medirGithub({ org: a.org, branch: a.branch });
  } catch (e) {
    if (!(e instanceof NoSePudo)) throw e;
    res = { listaCompleta: false, motivo: e.message, repos: [] };
  }
  for (const r of res.repos) console.log(`${limpio(r.nombre, 120)}: ${r.estado} — ${limpio(r.motivo, 200)}`);
  if (!res.listaCompleta) console.log(`la lista de repos no se pudo leer entera: ${limpio(res.motivo, 200)}`);
  const l = linea(res);
  console.log(l);
  console.log('(`requerido` no prueba que el portón corra: dice que la rama exige una compilación cuyo YAML lo nombra)');
  console.log('(la cuenta es la de los repos que la credencial ve: una sin alcance sobre los privados los deja afuera sin error)');
  if (a.out) fs.writeFileSync(a.out, `${l}\n`);
  return res.listaCompleta && !res.repos.some((r) => r.estado === 'no-medido') ? 0 : 1;
}

if (require.main === module) main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error(e && e.stack ? e.stack : e); process.exitCode = 1; });

module.exports = { linea, juntarLineas, parseArgs, medirAzure, medirGithub, nombraElPorton, tieneEscape, nombresDeTrabajos, esDelTrabajo, main };
