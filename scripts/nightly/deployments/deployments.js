#!/usr/bin/env node
/**
 * deployments.js — la foto de despliegues de cada noche.
 *
 * POR QUÉ EXISTE: «qué llegó a producción y qué quedó en staging» es lo que más importa saber de los proyectos, y
 * el resultado de la corrida no lo dice. Una corrida `succeeded` no prueba nada sobre producción: si nadie
 * aprueba, la aprobación vence, el stage queda `skipped` y la corrida igual dice `succeeded` (regla ADO 6 del equipo).
 * Esta foto lee el STAGE de cada corrida (azure.js, github.js) y la deja por producto, para la ficha de despliegues del
 * tablero y la pestaña Proyectos del sitio de la organización.
 *
 * QUÉ LEE
 *   · `operations.json` → `deployments` (lector: scripts/lib/operations-config.js). Cada organización declara su
 *     proveedor y, por producto, los pipelines (Azure) o environments (GitHub) de `staging` y `production` con sus
 *     identificadores de stage EXACTOS. Ningún nombre por defecto vive en el código (decisiones 2 y 4).
 *   · `scripts/nightly/dependencies/repos.json` → la lista de productos de la organización (los que no declaró salen
 *     «no medido» con `sin_declarar`) y `azure.org` como organización por defecto.
 *
 * QUÉ ESCRIBE: `<out>/deployments-<día UTC>.json`, atómico (tmp + rename), con EXACTAMENTE estas claves:
 *   { v: 1, generado, proveedor, ventana, productos: { "<producto>": {
 *       estado: medido|parcial|no_medido, motivo,
 *       staging, produccion:  { estado: desplegado, fecha, corrida, commit, commit_fuente, con_avisos, pipeline,
 *                               constancia_humo } | { estado: sin_despliegue_en_ventana, ventana } | { estado: no_medido, motivo },
 *       produccion_atrasada: true|false|null,
 *       aprobacion: { estado: pendiente|vencida|no_aprobada|ninguna|no_medido, desde?, corrida?, cuantas?, resultado?,
 *                     vencida?, motivo? },
 *       main: roto|con_avisos|verde|sin_corridas|no_medido,
 *       pipelines: [ { pipeline, entorno, estado, motivo, detalle } ] } },
 *     avisos: [ { codigo, producto, pipeline } ], fallas: [ { codigo, producto, pipeline } ] }
 *   `motivo` es SIEMPRE un código de MOTIVOS (abajo); `detalle`, el texto de la falla saneado (sin direcciones, correos,
 *   GUID ni el texto entre comillas de un mensaje TF…, a lo sumo 200 caracteres). `avisos` y `fallas` llevan sólo
 *   códigos y el nombre declarado del pipeline. Nada más: lista blanca campo por campo.
 *
 * 🔴 «No medido» nunca es «sin despliegue» ni «verde»: un pipeline que no se pudo leer sale `no_medido` con su motivo, y
 *    su producto `parcial` o `no_medido`. Bajo TF_BUILD cada falla sale además como `##vso[task.logissue type=warning]`.
 * Al registro: una línea por producto (estado, motivo y, por entorno, corrida y commit), nunca `detalle`.
 *
 * USO
 *   node scripts/nightly/deployments/deployments.js [--today AAAA-MM-DD] [--out <carpeta>] [--operations <archivo>]
 *        [--repos <archivo>] [--org <url>] [--budget-ms 600000]
 *   --out por defecto `.dashboard/deployments`; --operations, `operations.json` de la carpeta actual; --repos, el
 *   repos.json del árbol; --org, `azure.org` de repos.json. Con TYCON_DEPLOYMENTS_REQUIRE_GH_TOKEN=1 (el modelo de
 *   GitHub) y sin GH_TOKEN, las entradas de GitHub salen `sin_credencial`.
 *
 * SALIDA: 0 escribió la foto (aunque haya «no medido») · 1 argumentos · 2 no pudo escribir, u operations.json no valida
 */
'use strict';

const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..', '..', '..');
const { readEnv } = require(path.join(RAIZ, 'scripts', 'lib', 'legacy-names.js'));
const VENTANA = 30;
const PRESUPUESTO_MS = 600000;
const MOTIVOS = [
  'ok', 'sin_declarar', 'sin_permiso', 'az_fallo', 'gh_fallo', 'respuesta_no_json', 'presupuesto_agotado',
  'pipeline_no_encontrado', 'pipeline_ambiguo', 'environment_no_existe', 'sin_credencial', 'promocion_manual_sin_commit',
  'parcial', 'error_interno', 'github_no_distingue_vencida', 'repos_json_ilegible', 'commit_no_leido',
];
const AVISOS = ['no_esta_en_repos_json'];
const ENTORNOS = [['staging', 'staging'], ['production', 'produccion']];
const PEOR_MAIN = ['roto', 'no_medido', 'con_avisos', 'verde', 'sin_corridas'];

/** El texto de una falla, saneado. */
function sanear(t) {
  return String(t || '')
    .replace(/(TF\d+:[^']*)'[^']*'/g, '$1<…>')
    .replace(/'[^']*'/g, '<…>')
    .replace(/https?:\/\/\S+/gi, '<dirección>')
    .replace(/[^\s@'"<>]+@[^\s@'"<>]+\.[^\s@'"<>]+/g, '<correo>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<guid>')
    .replace(/#{2,}/g, '#')
    .replace(/\s+/g, ' ').trim().slice(0, 200);
}
const limpio = (t) => String(t == null ? '' : t).replace(/#{2,}/g, '#').replace(/\s+/g, ' ').trim();
const esFecha = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

function argumentos(argv) {
  const o = { budgetMs: PRESUPUESTO_MS };
  const pide = { '--today': 'today', '--out': 'out', '--operations': 'operations', '--repos': 'repos', '--org': 'org', '--budget-ms': 'budgetMs' };
  for (let i = 0; i < argv.length; i++) {
    const k = pide[argv[i]];
    if (!k || argv[i + 1] === undefined) return { error: `argumento desconocido o sin valor: ${argv[i]}` };
    o[k] = argv[++i];
  }
  o.today = o.today || readEnv('TYCON_TODAY', { where: 'scripts/nightly/deployments/deployments.js' }) || new Date().toISOString().slice(0, 10);
  if (!esFecha(o.today)) return { error: `--today ilegible: ${o.today}` };
  o.budgetMs = Number(o.budgetMs);
  if (!Number.isFinite(o.budgetMs) || o.budgetMs < 0) return { error: '--budget-ms tiene que ser un número de milisegundos' };
  o.out = o.out || path.join('.dashboard', 'deployments');
  o.operations = o.operations || 'operations.json';
  o.repos = o.repos || path.join(RAIZ, 'scripts', 'nightly', 'dependencies', 'repos.json');
  return o;
}

function leerRepos(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const productos = [...new Set((j.repos || []).filter((r) => r && r.producto && r.activo !== false).map((r) => String(r.producto)))];
    return { productos, org: j.azure && j.azure.org, leido: true };
  } catch (e) { return { productos: [], org: null, leido: false, motivo: (e && e.code) || 'ilegible' }; }
}

const noMedidoEnt = (motivo) => ({ estado: 'no_medido', motivo });

/** Junta los resultados de las entradas de un producto en su ficha. */
function armarProducto(resultados, declarado) {
  const pipelines = resultados.map((r) => ({ pipeline: r.pipeline, entorno: r.entorno, estado: r.ok ? 'medido' : 'no_medido', motivo: r.ok ? 'ok' : r.motivo, detalle: r.ok ? '' : sanear(r.detalle) }));
  const p = { estado: 'medido', motivo: 'ok', staging: null, produccion: null, produccion_atrasada: null, aprobacion: null, main: 'no_medido', pipelines };
  for (const [clave, campo] of ENTORNOS) {
    const delLado = resultados.filter((r) => r.entorno === clave);
    if (!declarado[clave] || delLado.length === 0) { p[campo] = noMedidoEnt('sin_declarar'); continue; }
    const ok = delLado.filter((r) => r.ok);
    const conDespliegue = ok.filter((r) => r.ultimo).sort((a, b) => Date.parse(b.ultimo.fecha) - Date.parse(a.ultimo.fecha));
    if (conDespliegue.length) {
      const u = conDespliegue[0];
      p[campo] = { estado: 'desplegado', fecha: u.ultimo.fecha, corrida: u.ultimo.corrida, commit: u.ultimo.commit, commit_fuente: u.ultimo.commit_fuente,
        con_avisos: !!u.ultimo.con_avisos, pipeline: u.pipeline, constancia_humo: u.ultimo.constancia_humo, _confiable: u.ultimo.confiable, _motivo: u.ultimo.motivo_commit };
    } else if (ok.length === delLado.length) p[campo] = { estado: 'sin_despliegue_en_ventana', ventana: VENTANA };
    else p[campo] = noMedidoEnt(delLado.find((r) => !r.ok).motivo);
  }
  // la aprobación: pendiente > vencida > no_aprobada > ninguna; si alguna entrada no se leyó y no hay nada, no medida
  const prod = resultados.filter((r) => r.entorno === 'production');
  const aprobs = prod.filter((r) => r.ok && r.aprobacion).map((r) => r.aprobacion);
  const orden = ['pendiente', 'vencida', 'no_aprobada'];
  let ap = null;
  // entre varios pipelines de producción, la corrida que se muestra es la más nueva; `cuantas` se suma
  const masNueva = (xs) => xs.reduce((a, b) => ((b._fecha || 0) > (a._fecha || 0) ? b : a));
  for (const e of orden) { const xs = aprobs.filter((a) => a.estado === e); if (xs.length) { ap = e === 'vencida' ? { ...masNueva(xs), cuantas: xs.reduce((n, a) => n + a.cuantas, 0) } : masNueva(xs); break; } }
  if (ap && '_fecha' in ap) { ap = { ...ap }; delete ap._fecha; }
  if (!ap) ap = prod.length === 0 ? { estado: 'no_medido', motivo: 'sin_declarar' } : prod.some((r) => !r.ok) ? { estado: 'no_medido', motivo: prod.find((r) => !r.ok).motivo } : (aprobs.find((a) => a.vencida) || { estado: 'ninguna' });
  p.aprobacion = ap;
  // main: el peor de los pipelines de staging; uno sin leer nunca deja verde
  const mains = resultados.filter((r) => r.entorno === 'staging').map((r) => (r.ok && r.main ? r.main : 'no_medido'));
  if (mains.length) p.main = PEOR_MAIN.find((m) => mains.includes(m));
  // producción atrasada: staging más nuevo con otro commit; null si el commit de producción no es confiable
  const s = p.staging, pr = p.produccion;
  if (s.estado === 'desplegado' && pr.estado === 'desplegado') {
    if (!pr._confiable) { p.produccion_atrasada = null; p.motivo = MOTIVOS.includes(pr._motivo) ? pr._motivo : 'promocion_manual_sin_commit'; }
    else p.produccion_atrasada = Date.parse(s.fecha) > Date.parse(pr.fecha) && s.commit !== pr.commit;
  }
  for (const k of ['staging', 'produccion']) if (p[k]) { delete p[k]._confiable; delete p[k]._motivo; }
  if (pipelines.length === 0) { p.estado = 'no_medido'; p.motivo = 'sin_declarar'; return p; }
  const malos = pipelines.filter((x) => x.estado !== 'medido').length;
  const faltaLado = !declarado.staging || !declarado.production;
  if (malos === pipelines.length) { p.estado = 'no_medido'; p.motivo = pipelines[0].motivo; }
  else if (malos || faltaLado) { p.estado = 'parcial'; if (p.motivo === 'ok') p.motivo = malos ? 'parcial' : 'sin_declarar'; }
  return p;
}

function main() {
  const a = argumentos(process.argv.slice(2));
  if (a.error) { process.stderr.write(`deployments: ${a.error}\n`); return 1; }
  const inicio = Date.now();
  const deadline = inicio + a.budgetMs;
  const tf = /^true$/i.test(process.env.TF_BUILD || '');

  const { load } = require(path.join(RAIZ, 'scripts', 'lib', 'operations-config.js'));
  let cfg = null, faltaConfig = null;
  const c = load(a.operations);
  if (c.couldNotRead) faltaConfig = `operations.json no está o no se puede leer (${path.basename(a.operations)})`;
  else if (!c.ok) {
    for (const pr of c.problems) process.stderr.write(`deployments: operations.json no valida: ${pr.path || '(el archivo)'}: ${pr.message}\n`);
    return 2;
  } else cfg = c.data.deployments || null;

  const repos = leerRepos(a.repos);
  const org = a.org || repos.org;
  const proveedor = cfg ? cfg.provider : null;
  const declarados = cfg ? cfg.products : {};
  const nombres = [...new Set([...repos.productos, ...Object.keys(declarados).filter((k) => !k.startsWith('__'))])];
  const avisos = [], fallas = [];
  const productos = {};
  // sin repos.json, los productos que sólo nombra él no aparecen: se dice como falla, nunca en silencio
  if (!repos.leido) {
    fallas.push({ codigo: 'repos_json_ilegible', producto: null, pipeline: null });
    if (tf) process.stdout.write(`##vso[task.logissue type=warning]deployments: no pude leer repos.json (${limpio(repos.motivo)}): sólo salen los productos declarados\n`);
  }

  let lector = null;
  if (proveedor === 'azure') lector = org ? require('./azure.js').crear({ org, deadline, ventana: VENTANA }) : null;
  if (proveedor === 'github') lector = require('./github.js').crear({ deadline, ventana: VENTANA });

  for (const nombre of nombres) {
    const decl = declarados[nombre];
    if (!decl) {
      const detalle = faltaConfig || 'sin declarar en operations.json → deployments';
      productos[nombre] = { estado: 'no_medido', motivo: 'sin_declarar', staging: noMedidoEnt('sin_declarar'), produccion: noMedidoEnt('sin_declarar'),
        produccion_atrasada: null, aprobacion: { estado: 'no_medido', motivo: 'sin_declarar' }, main: 'no_medido',
        pipelines: [{ pipeline: null, entorno: null, estado: 'no_medido', motivo: 'sin_declarar', detalle }] };
      continue;
    }
    // sin repos.json legible el aviso sería falso para todos: la falla repos_json_ilegible ya lo dice
    if (repos.leido && !repos.productos.includes(nombre)) avisos.push({ codigo: 'no_esta_en_repos_json', producto: nombre, pipeline: null });
    const resultados = [];
    for (const [clave] of ENTORNOS) {
      for (const entrada of decl[clave] || []) {
        const etiqueta = proveedor === 'azure' ? entrada.pipeline : `${entrada.repo}:${entrada.environment}`;
        try {
          if (!lector) throw { noMedido: true, motivo: 'az_fallo', detalle: 'sin organización de Azure DevOps (--org o azure.org de repos.json)' };
          if (proveedor === 'github' && process.env.TYCON_DEPLOYMENTS_REQUIRE_GH_TOKEN === '1' && !process.env.GH_TOKEN) {
            throw { noMedido: true, motivo: 'sin_credencial', detalle: 'sin el token de la GitHub App de operaciones (GH_TOKEN)' };
          }
          resultados.push({ ok: true, pipeline: etiqueta, entorno: clave, ...lector.leer(entrada, clave) });
        } catch (e) {
          const motivo = e && e.noMedido && MOTIVOS.includes(e.motivo) ? e.motivo : 'error_interno';
          resultados.push({ ok: false, pipeline: etiqueta, entorno: clave, motivo, detalle: e && e.noMedido ? e.detalle : String((e && e.message) || e) });
          fallas.push({ codigo: motivo, producto: nombre, pipeline: etiqueta });
          if (tf) process.stdout.write(`##vso[task.logissue type=warning]deployments: ${limpio(nombre)} · ${limpio(etiqueta)}: ${motivo}\n`);
        }
      }
    }
    productos[nombre] = armarProducto(resultados, { staging: (decl.staging || []).length > 0, production: (decl.production || []).length > 0 });
  }

  const foto = { v: 1, generado: new Date().toISOString(), proveedor, ventana: VENTANA, productos, avisos, fallas };
  const destino = path.join(a.out, `deployments-${a.today}.json`);
  const tmp = `${destino}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(a.out, { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(foto, null, 2)}\n`);
    fs.renameSync(tmp, destino);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* no llegó a existir */ }
    process.stderr.write(`deployments: no pude escribir ${destino}: ${(e && e.code) || e}\n`);
    return 2;
  }

  const lado = (x) => (x && x.estado === 'desplegado' ? `#${limpio(x.corrida)} ${limpio(x.commit)}` : (x ? x.estado : '-'));
  for (const [n, p] of Object.entries(productos)) {
    process.stdout.write(`deployments: ${limpio(n)} · ${p.estado} · ${p.motivo} · staging ${lado(p.staging)} · produccion ${lado(p.produccion)} · aprobacion ${p.aprobacion.estado} · main ${p.main}\n`);
  }
  process.stdout.write(`deployments: ${Object.keys(productos).length} producto(s), ${fallas.length} falla(s), ${Date.now() - inicio} ms → ${destino}\n`);
  return 0;
}

module.exports = { MOTIVOS, AVISOS, sanear, armarProducto };

// exitCode y no exit(): con la salida a una tubería, process.exit() corta lo que todavía no se escribió (main es
// sincrónica y no deja nada abierto, así que el proceso termina solo)
if (require.main === module) process.exitCode = main();
