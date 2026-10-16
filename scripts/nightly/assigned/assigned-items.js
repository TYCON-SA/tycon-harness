#!/usr/bin/env node
'use strict';
/*
 * assigned-items.js — LOS PEDIDOS ABIERTOS ASIGNADOS A CADA PERSONA, DE CADA NOCHE (story 2.23, AC 16; decisión 20).
 *
 * El sitio de la organización le muestra a cada dev lo que tiene asignado. No consulta la plataforma en vivo (eso le
 * pediría una credencial con lectura de pedidos de toda la organización): lee este archivo, que deja el nocturno del
 * tablero cada noche en el repo de operaciones, `.dashboard/assigned/assigned-<día>.json`. El costo, dicho en la
 * pantalla: lo asignado se ve con hasta un día de atraso.
 *
 * QUÉ CONSULTA: por cada proyecto de los repos ACTIVOS de `repos.json`, una WIQL acotada al proyecto
 * (`[System.TeamProject] = @project`) con los pedidos con alguien asignado que no están cerrados; y los campos de esos
 * pedidos en lotes de 200 (`wit/workitemsbatch`). Sólo lecturas. Habla con Azure sólo por `TYCON_ADO_CMD` (por defecto
 * `az`), siempre con `--org` y `-o json`; las suites usan scripts/tests/lib/fake-az.sh.
 *
 * QUÉ ESCRIBE (lista blanca): por pedido, `id`, `proyecto`, `tipo`, `estado`, `asignado` (la identidad única, en
 * minúsculas), `dias_en_estado` (null si la plataforma no da la fecha: nunca 0), `enlace` y `dependencias` (true si es un
 * Bug de dependencias del arnés: la etiqueta `arnes-hallazgo`). NUNCA el título ni el nombre para mostrar.
 *
 * 🔴 No medido no es cero: si una consulta falla, el archivo se escribe igual con `estado: no_medido` y el motivo, y el
 *    guion sale 1. En GitHub (`--provider github`) deja `no_medido` con «los pull requests y los pedidos de GitHub
 *    todavía no se leen» y sale 0, sin consultar nada.
 *
 * USO
 *   node scripts/nightly/assigned/assigned-items.js --today <AAAA-MM-DD> --out <dir> [--repos <repos.json>] [--org <url>]
 *        [--provider azure|github]
 *   (--repos por defecto: scripts/nightly/dependencies/repos.json del árbol; --org: `ado.org` de la configuración del
 *    arnés, o `azure.org` de repos.json)
 *
 * SALIDA: 0 escrito y medido (o GitHub declarado) · 1 no se pudo consultar (el archivo lo dice) · 2 uso
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const LOTE = 200;
const CERRADOS = ['Closed', 'Done', 'Removed', 'Resolved', 'Completed', 'Cut'];
const CAMPOS = ['System.Id', 'System.TeamProject', 'System.WorkItemType', 'System.State', 'System.AssignedTo', 'Microsoft.VSTS.Common.StateChangeDate', 'System.Tags'];
const GITHUB = 'los pull requests y los pedidos de GitHub todavía no se leen';
const DIA = 86400000;

class NoSePudo extends Error {}
const recortar = (t, n = 200) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, n) || '(sin salida)';
const esFecha = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

function az(cmd, org, args) {
  const r = spawnSync(cmd, [...args, '--org', org, '-o', 'json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120000, env: process.env });
  if (r.error) throw new NoSePudo(`${cmd} no se pudo ejecutar (${r.error.code || r.error.message})`);
  if (r.status !== 0) throw new NoSePudo(`az salió ${r.status}: ${recortar(r.stderr || r.stdout)}`);
  try { return JSON.parse(r.stdout); } catch { throw new NoSePudo(`la respuesta no es JSON: ${recortar(r.stdout, 120)}`); }
}

/** Los proyectos de los repos activos de repos.json (la parte de `ado` antes de la barra), sin repetir. */
function proyectosDe(repos) {
  const s = new Set();
  for (const r of (repos && Array.isArray(repos.repos) ? repos.repos : [])) {
    if (!r || r.activo === false || typeof r.ado !== 'string' || !r.ado.includes('/')) continue;
    s.add(r.ado.split('/')[0].trim());
  }
  return [...s].filter(Boolean).sort();
}

const tokens = (tags) => String(tags || '').split(';').map((t) => t.trim().toLowerCase()).filter(Boolean);

/** Un work item de Azure → la fila de la lista blanca. */
function fila(w, { hoy, org }) {
  const f = (w && w.fields) || {};
  const id = Number(w && w.id);
  const proyecto = typeof f['System.TeamProject'] === 'string' ? f['System.TeamProject'].slice(0, 120) : null;
  const asig = f['System.AssignedTo'];
  const unico = asig && typeof asig === 'object' ? asig.uniqueName : (typeof asig === 'string' ? (asig.match(/<([^>]+)>/) || [])[1] : null);
  const cambio = Date.parse(f['Microsoft.VSTS.Common.StateChangeDate'] || '');
  return {
    id,
    proyecto,
    tipo: typeof f['System.WorkItemType'] === 'string' ? f['System.WorkItemType'].slice(0, 40) : null,
    estado: typeof f['System.State'] === 'string' ? f['System.State'].slice(0, 40) : null,
    asignado: typeof unico === 'string' && unico.trim() ? unico.trim().toLowerCase().slice(0, 200) : null,
    dias_en_estado: Number.isFinite(cambio) ? Math.max(0, Math.floor((Date.parse(`${hoy}T00:00:00Z`) - Date.parse(new Date(cambio).toISOString().slice(0, 10) + 'T00:00:00Z')) / DIA)) : null,
    enlace: org && proyecto && Number.isInteger(id) ? `${String(org).replace(/\/+$/, '')}/${encodeURIComponent(proyecto)}/_workitems/edit/${id}` : null,
    dependencias: f['System.WorkItemType'] === 'Bug' && tokens(f['System.Tags']).includes('arnes-hallazgo'),
  };
}

function consultar({ cmd, org, hoy, proyectos }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asignados-'));
  try {
    const pedidos = [];
    for (const proyecto of proyectos) {
      const q = path.join(tmp, 'wiql.json');
      fs.writeFileSync(q, JSON.stringify({ query: `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.AssignedTo] <> '' AND [System.State] NOT IN (${CERRADOS.map((s) => `'${s}'`).join(', ')}) ORDER BY [System.Id]` }));
      const r = az(cmd, org, ['devops', 'invoke', '--area', 'wit', '--resource', 'wiql', '--route-parameters', `project=${proyecto}`, '--http-method', 'POST', '--in-file', q, '--api-version', '7.1']);
      if (!r || !Array.isArray(r.workItems)) throw new NoSePudo(`la consulta de ${proyecto} no trae la lista de pedidos (workItems)`);
      const ids = r.workItems.map((w) => Number(w && w.id)).filter(Number.isInteger);
      for (let i = 0; i < ids.length; i += LOTE) {
        const b = path.join(tmp, 'lote.json');
        fs.writeFileSync(b, JSON.stringify({ ids: ids.slice(i, i + LOTE), fields: CAMPOS }));
        const l = az(cmd, org, ['devops', 'invoke', '--area', 'wit', '--resource', 'workitemsbatch', '--http-method', 'POST', '--in-file', b, '--api-version', '7.1']);
        if (!l || !Array.isArray(l.value)) throw new NoSePudo(`los campos de los pedidos de ${proyecto} no volvieron (value)`);
        for (const w of l.value) pedidos.push(fila(w, { hoy, org }));
      }
    }
    return pedidos.filter((p) => Number.isInteger(p.id) && p.asignado).sort((a, b) => a.id - b.id);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

function parseArgs(argv) {
  const a = { hoy: null, out: null, repos: null, org: null, provider: 'azure', error: null };
  const valor = (i) => (i < argv.length && !String(argv[i]).startsWith('--') ? argv[i] : (a.error = `falta el valor de ${argv[i - 1]}`, null));
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--today') a.hoy = valor(++i);
    else if (v === '--out') a.out = valor(++i);
    else if (v === '--repos') a.repos = valor(++i);
    else if (v === '--org') a.org = valor(++i);
    else if (v === '--provider') a.provider = valor(++i);
    else a.error = `opción desconocida: ${v}`;
  }
  return a;
}

function escribir(out, hoy, cuerpo) {
  fs.mkdirSync(out, { recursive: true });
  const archivo = path.join(out, `assigned-${hoy}.json`);
  const tmp = `${archivo}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify({ v: 1, fecha: hoy, generado: new Date().toISOString(), ...cuerpo }, null, 1)}\n`);
  fs.renameSync(tmp, archivo);
  return archivo;
}

function main(argv) {
  const a = parseArgs(argv);
  const uso = 'uso: assigned-items.js --today <AAAA-MM-DD> --out <dir> [--repos <repos.json>] [--org <url>] [--provider azure|github]';
  if (a.error || !esFecha(a.hoy) || !a.out || !['azure', 'github'].includes(a.provider)) { console.error(a.error || uso); return 2; }
  if (a.provider === 'github') {
    escribir(a.out, a.hoy, { estado: 'no_medido', motivo: GITHUB, pedidos: [] });
    console.log(`pedidos asignados: no medido — ${GITHUB}`);
    return 0;
  }
  let codigo = 0;
  let cuerpo;
  try {
    const rutaRepos = a.repos || path.join(__dirname, '..', 'dependencies', 'repos.json');
    let repos;
    try { repos = JSON.parse(fs.readFileSync(rutaRepos, 'utf8')); } catch (e) { throw new NoSePudo(`no se pudo leer repos.json (${e.code || 'no es JSON'})`); }
    let org = a.org;
    if (!org) {
      try {
        const ado = require(path.join(__dirname, '..', '..', 'lib', 'tycon-config.js')).integracionParaComando('ado');
        if (ado.prendida) org = ado.config.valores.ado.org;
      } catch (e) { if (e && e.name === 'ConfigError') throw e; }
    }
    if (!org && repos && repos.azure && typeof repos.azure.org === 'string') org = repos.azure.org;
    if (!org) throw new NoSePudo('sin organización de Azure DevOps (--org, ado.org de la configuración o azure.org de repos.json)');
    const pedidos = consultar({ cmd: process.env.TYCON_ADO_CMD || 'az', org, hoy: a.hoy, proyectos: proyectosDe(repos) });
    cuerpo = { estado: 'medido', motivo: null, pedidos };
  } catch (e) {
    if (e && e.name === 'ConfigError') { console.error(e.message); return 2; }
    const motivo = e instanceof NoSePudo ? e.message : `error inesperado: ${recortar(e && e.message)}`;
    cuerpo = { estado: 'no_medido', motivo: recortar(motivo.replace(/#{2,}/g, '#'), 240), pedidos: [] };
    codigo = 1;
  }
  try { escribir(a.out, a.hoy, cuerpo); } catch (e) { console.error(`🔴 pedidos asignados: no se pudo escribir en ${a.out}: ${e.message}`); return 1; }
  if (codigo) console.error(`🔴 pedidos asignados: no medido — ${cuerpo.motivo}`);
  else console.log(`pedidos asignados: ${cuerpo.pedidos.length} pedido(s) abiertos con alguien asignado`);
  return codigo;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { fila, proyectosDe, parseArgs, GITHUB };
