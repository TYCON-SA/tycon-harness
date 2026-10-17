#!/usr/bin/env node
/**
 * open-prs.js — los pull requests de la organización que llevan más de N días abiertos
 * (story 4.6, 2026-09-17).
 *
 * Nace de un pull request del backend de un producto (guides/maintaining/incident-log.md#pr-trabado-con-auto-completar-2026-09-17): creado CON auto-completar, su build falló porque `main` estaba
 * roto, el arreglo entró por otro lado y el PR quedó 13 días esperando un verde que nunca iba a
 * llegar. Lo encontró otro dev de casualidad. El freno de auto-completar no alcanza: el hueco es que
 * nadie se entera cuando un PR no puede entrar.
 *
 * Arma la línea que el vigilante pega al final del resumen diario (`daily-summary.js deliver --extra <archivo>`).
 * 🔴 Lo que va al aviso es SÓLO LA CANTIDAD: `--out` escribe «PR abiertos hace más de N días: K», o
 * «…: ? (no se pudo consultar)» sin el motivo. El aviso sale a un servicio de afuera; los repos, los títulos, los autores
 * y el motivo de `az` (que nombra la organización) quedan en stdout, el registro del pipeline. Nada más:
 *
 * 1. **No diagnostica el motivo.** Un PR con auto-completar entra en minutos; si sigue abierto a los
 *    N días, está trabado — por build rojo, conflictos, aprobación u olvido, da igual. El criterio es
 *    la antigüedad (días calendario UTC entre `creationDate` y `--today`, estrictamente mayor que N).
 * 2. **Sólo avisa.** No comenta, no cierra, no reintenta. Sólo lecturas.
 * 3. **Fuera:** borradores y ramas `vigilante/*` y `dependencias/*` (las colas del arnés ya tienen
 *    su rubro en el resumen).
 * 4. **El registro (stdout): tope de 10 líneas**, del más nuevo al más viejo; los más viejos se cortan con «(+N más)».
 * 5. 🔴 **No medido no es cero.** Si `az` sale ≠ 0 o contesta algo ilegible, la sección dice
 *    «PR abiertos: no se pudo consultar (<motivo>)», se escribe igual y el guion sale 1. Nunca
 *    «ninguno» ni silencio (incident-log#comando-fallado-leido-como-vacio-2026-09-04).
 * 6. **Paginado:** `$top=100` + `$skip` hasta una página incompleta (medido: el endpoint corta en 101
 *    sin avisar). Tope de seguridad de 50 páginas, que se dice como falla.
 *
 * Habla con Azure sólo por `TYCON_ADO_CMD` (por defecto `az`), siempre con `--org` y `-o json`, sin
 * descartar stderr. Las suites usan `scripts/tests/lib/fake-az.sh`.
 *
 * USO
 *   node scripts/nightly/open-prs/open-prs.js --today <YYYY-MM-DD> [--days 2] [--out <archivo>] [--json <archivo>] [--org <url>]
 *   --json (story 2.23): además, el archivo para el sitio de la organización (`.dashboard/open-prs/open-prs-<día>.json`):
 *   número, proyecto, repo, días, autor (identidad única) y enlace de cada PR abierto; sin título ni nombre para mostrar.
 *   (--org por defecto: `azure.org` de scripts/nightly/dependencies/repos.json)
 *
 * SALIDA: 0 la sección se armó · 1 no se pudo consultar (la sección lo dice) · 2 uso
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DIA_MS = 86400000;
const POR_PAGINA = 100;
const MAX_PAGINAS = 50;
const MAX_LINEAS = 10;
const RAMAS_DEL_ARNES = /^refs\/heads\/(vigilante|dependencias)\//;
const GITHUB = 'los pull requests y los pedidos de GitHub todavía no se leen';

const recortar = (t, n = 200) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, n) || '(sin salida)';
/**
 * 🔴 Texto de afuera (nombre de proyecto, de repo, de autor) antes de imprimirlo. Azure interpreta `##vso[…]` y
 * `##[…]` en CUALQUIER línea de stdout del paso: un display name así fijaba variables o marcaba la corrida
 * (SEC-C5, revisión de la story 4.6). Se rompe el `##` y se aplanan los saltos de línea.
 */
const limpio = (t, n) => recortar(String(t || '').replace(/#{2,}/g, '#'), n);
const esFecha = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

class NoSePudo extends Error {}

function consultarPagina({ cmd, org }, skip) {
  const r = spawnSync(cmd, ['devops', 'invoke', '--area', 'git', '--resource', 'pullRequests',
    '--query-parameters', 'searchCriteria.status=active', `$top=${POR_PAGINA}`, `$skip=${skip}`,
    '--api-version', '7.1', '--org', org, '-o', 'json'], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120000, env: process.env,
  });
  if (r.error) throw new NoSePudo(`${cmd} no se pudo ejecutar (${r.error.code || r.error.message})`);
  if (r.status !== 0) throw new NoSePudo(`az salió ${r.status}: ${recortar(r.stderr || r.stdout)}`);
  let j;
  try { j = JSON.parse(r.stdout); } catch { throw new NoSePudo(`la respuesta no es JSON: ${recortar(r.stdout, 120)}`); }
  if (!j || !Array.isArray(j.value)) throw new NoSePudo('la respuesta no trae la lista de pull requests (value)');
  return j.value;
}

function listarActivos(conexion) {
  const todos = [];
  for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
    const v = consultarPagina(conexion, pagina * POR_PAGINA);
    todos.push(...v);
    if (v.length < POR_PAGINA) return todos;
  }
  throw new NoSePudo(`más de ${MAX_PAGINAS * POR_PAGINA} pull requests activos: se cortó el paginado`);
}

function diasAbierto(pr, hoy) {
  const creado = Date.parse(`${String(pr.creationDate || '').slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(creado)) return null;
  return Math.round((Date.parse(`${hoy}T00:00:00Z`) - creado) / DIA_MS);
}

/** Pura: de la lista de Azure a las líneas de la sección. */
function seccion(prs, { hoy, dias }) {
  const trabados = prs
    .filter((p) => p && !p.isDraft && !RAMAS_DEL_ARNES.test(String(p.sourceRefName || '')))
    .map((p) => ({ p, d: diasAbierto(p, hoy) }));
  // 🔴 Un PR sin fecha legible no se descarta en silencio (hallazgo del pase adversarial): no se puede medir su
  // antigüedad, así que se CUENTA aparte. No medido no es cero, tampoco por registro.
  const sinFecha = trabados.filter((x) => x.d === null).length;
  const medidos = trabados
    .filter((x) => x.d !== null && x.d > dias)
    .sort((a, b) => a.d - b.d || a.p.pullRequestId - b.p.pullRequestId);
  const titulo = `PR abiertos hace más de ${dias} días`;
  const pie = sinFecha ? [`(${sinFecha} PR sin fecha legible: no se pudo medir su antigüedad)`] : [];
  if (medidos.length === 0) return [`${titulo}: ninguno`, ...pie];
  const repo = (p) => {
    const r = p.repository || {};
    return `${limpio((r.project && r.project.name) || '?', 30)}/${limpio(r.name || '?', 30)}`;
  };
  const autor = (p) => limpio((p.createdBy && p.createdBy.displayName) || '?', 30);
  const lineas = medidos.slice(0, MAX_LINEAS).map(({ p, d }) => `#${Number(p.pullRequestId)} ${repo(p)} — ${autor(p)} — ${d} días`);
  if (medidos.length > MAX_LINEAS) lineas.push(`(+${medidos.length - MAX_LINEAS} más)`);
  return [`${titulo}: ${medidos.length}`, ...lineas, ...pie];
}

/**
 * La línea del aviso (`--out`), sólo la cantidad. `n === null` = no se midió («?», sin el motivo). Los PR sin
 * fecha legible se cuentan aparte, como en la sección: no medido no es cero, tampoco en el aviso.
 */
const cantidad = (dias, n) => (n === null ? `PR abiertos hace más de ${dias} días: ? (no se pudo consultar)`
  : `PR abiertos hace más de ${dias} días: ${n.viejos}${n.sinFecha ? ` (+${n.sinFecha} sin fecha legible)` : ''}`);
function contar(prs, { hoy, dias }) {
  const edades = prs.filter((p) => p && !p.isDraft && !RAMAS_DEL_ARNES.test(String(p.sourceRefName || ''))).map((p) => diasAbierto(p, hoy));
  return { viejos: edades.filter((d) => d !== null && d > dias).length, sinFecha: edades.filter((d) => d === null).length };
}

/**
 * story 2.23: lo que deja la noche para el sitio de la organización (`--json <archivo>`). Lista blanca: por PR, número,
 * proyecto, repo, días abierto, la identidad única del autor (`createdBy.uniqueName`, en minúsculas) y el enlace —NUNCA el
 * título ni el nombre para mostrar—. Las mismas exclusiones que la sección (borradores y colas del arnés), sin el corte de
 * antigüedad: el sitio muestra a cada dev todos sus PR abiertos.
 */
function paraElSitio(prs, { hoy, org }) {
  const base = String(org || '').replace(/\/+$/, '');
  // el paginado sobre una lista viva puede traer el mismo PR en dos páginas: uno por número
  const vistos = new Set();
  return prs
    .filter((p) => p && !p.isDraft && !RAMAS_DEL_ARNES.test(String(p.sourceRefName || '')) && Number.isInteger(Number(p.pullRequestId)))
    .filter((p) => { const n = Number(p.pullRequestId); if (vistos.has(n)) return false; vistos.add(n); return true; })
    .map((p) => {
      const r = p.repository || {};
      const proyecto = (r.project && typeof r.project.name === 'string') ? r.project.name.slice(0, 120) : null;
      const repo = typeof r.name === 'string' ? r.name.slice(0, 120) : null;
      const numero = Number(p.pullRequestId);
      const unico = p.createdBy && typeof p.createdBy.uniqueName === 'string' ? p.createdBy.uniqueName.trim().toLowerCase().slice(0, 200) : null;
      return { numero, proyecto, repo, dias: diasAbierto(p, hoy), autor: unico,
        enlace: base && proyecto && repo ? `${base}/${encodeURIComponent(proyecto)}/_git/${encodeURIComponent(repo)}/pullrequest/${numero}` : null };
    })
    .sort((a, b) => a.numero - b.numero);
}

function parseArgs(argv) {
  const a = { hoy: null, dias: 2, out: null, json: null, provider: null, org: null, error: null, ayuda: false };
  const valor = (i) => (i < argv.length && !String(argv[i]).startsWith('--') ? argv[i] : (a.error = `falta el valor de ${argv[i - 1]}`, null));
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--today') a.hoy = valor(++i);
    else if (v === '--days') a.dias = valor(++i);
    else if (v === '--out') a.out = valor(++i);
    else if (v === '--json') a.json = valor(++i);
    else if (v === '--provider') a.provider = valor(++i);
    else if (v === '--org') a.org = valor(++i);
    else if (v === '-h' || v === '--help') a.ayuda = true;
    else a.error = `opción desconocida: ${v}`;
  }
  return a;
}

/**
 * La organización sin `--org`: `ado.org` de la configuración del arnés (story 8.3 — TYCON_ADO_ORG, ~/.claude/tycon.json
 * o el perfil del equipo; antes salía de `nightly/dependencies/repos.json`, que es operación interna y no se publica).
 * Sin organización, Azure DevOps está APAGADA en esta máquina: la sección lo dice y el guion sale 0 — nunca «ninguno»
 * sin haber mirado (AC 10). Una configuración rota frena con archivo, clave y motivo (exit 2): un comando no adivina.
 */
function organizacionConfigurada() {
  const cfg = require(path.join(__dirname, '..', '..', 'lib', 'tycon-config.js'));
  const ado = cfg.integracionParaComando('ado');
  return { prendida: ado.prendida, apagada: ado.apagada, org: ado.prendida ? ado.config.valores.ado.org : null };
}

function main(argv) {
  const a = parseArgs(argv);
  const uso = () => console.error('uso: open-prs.js --today <YYYY-MM-DD> [--days 2] [--out <archivo>] [--org <url>]');
  if (a.ayuda) { uso(); return 0; }
  const dias = Number(a.dias);
  if (a.error || !esFecha(a.hoy) || !Number.isInteger(dias) || dias < 0) {
    console.error(a.error || (!esFecha(a.hoy) ? `--today tiene que ser una fecha YYYY-MM-DD, no «${a.hoy}»` : `--days tiene que ser un entero ≥ 0, no «${a.dias}»`));
    uso();
    return 2;
  }

  let lineas;
  let n = null;       // la cantidad que va al aviso; null = no se midió
  let codigo = 0;
  let sitio = null;   // story 2.23: el archivo para el sitio
  if (a.provider && !['azure', 'github'].includes(a.provider)) { console.error(`--provider tiene que ser azure o github, no «${a.provider}»`); uso(); return 2; }
  try {
    let org = a.org;
    if (a.provider === 'github') {
      // story 2.23 (AC 16): en GitHub los pull requests todavía no se leen; se declara, nunca «ninguno»
      lineas = [`PR abiertos: no medido — ${GITHUB}`];
      sitio = { estado: 'no_medido', motivo: GITHUB, prs: [] };
    }
    if (!lineas && !org) {
      const ado = organizacionConfigurada();
      if (!ado.prendida) { lineas = [`PR abiertos: ${ado.apagada}`]; sitio = { estado: 'no_medido', motivo: limpio(ado.apagada, 180), prs: [] }; }
      else org = ado.org;
    }
    if (!lineas) {
      const activos = listarActivos({ cmd: process.env.TYCON_ADO_CMD || 'az', org });
      lineas = seccion(activos, { hoy: a.hoy, dias });
      n = contar(activos, { hoy: a.hoy, dias });
      sitio = { estado: 'medido', motivo: null, prs: paraElSitio(activos, { hoy: a.hoy, org }) };
    }
  } catch (e) {
    if (e && e.name === 'ConfigError') { console.error(e.message); return 2; }
    const motivo = e instanceof NoSePudo ? e.message : `error inesperado: ${recortar(e.message)}`;
    lineas = [`PR abiertos: no se pudo consultar (${limpio(motivo, 180)})`];
    sitio = { estado: 'no_medido', motivo: limpio(motivo, 180), prs: [] };
    codigo = 1;
  }
  if (a.json) {
    try {
      fs.mkdirSync(path.dirname(path.resolve(a.json)), { recursive: true });
      const tmp = `${a.json}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, `${JSON.stringify({ v: 1, fecha: a.hoy, generado: new Date().toISOString(), ...sitio }, null, 1)}\n`);
      fs.renameSync(tmp, a.json);
    } catch (e) {
      console.error(`🔴 prs-abiertos: no se pudo escribir ${a.json}: ${e.message}`);
      codigo = 1;
    }
  }
  const texto = lineas.join('\n');
  console.log(texto);
  if (a.out) {
    try { fs.writeFileSync(a.out, `${cantidad(dias, n)}\n`); } catch (e) {
      console.error(`🔴 prs-abiertos: no se pudo escribir ${a.out}: ${e.message}`);
      return 1;
    }
  }
  if (codigo) console.error(`🔴 ${texto}`);
  return codigo;
}

if (require.main === module) {
  // story 8.9: las opciones viejas en castellano siguen andando hasta el retiro
  require('../../lib/legacy-names.js').aliasArgv('scripts/nightly/open-prs/open-prs.js', { exitCode: 2 });
  process.exit(main(process.argv.slice(2)));
}
module.exports = { seccion, contar, cantidad, diasAbierto, parseArgs, paraElSitio };
