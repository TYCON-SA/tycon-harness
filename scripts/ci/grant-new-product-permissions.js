#!/usr/bin/env node
'use strict';
/**
 * Deja a un proyecto de Azure DevOps recién creado con TODOS los permisos que sus pipelines
 * necesitan para funcionar. Son cuatro, y cada uno se descubrió chocándose contra él.
 *
 * 🔴 POR QUÉ EXISTE (alta de un producto nuevo, 2026-09-28, y su repetición el mismo día
 *    — guides/incident-log.md#case-new-product-permissions-2026-09-28).
 *
 * Un producto nuevo no arranca hasta tener las cuatro cosas de abajo. Ninguna da un error que se
 * entienda, y las cuatro se ven igual: "el pipeline falla y no sé por qué".
 *
 *   1. LECTURA sobre el repo del arnés — de donde bajan los guiones de notas de versión, humo,
 *      despliegue y el portón de controles.
 *   2. PERTENENCIA al grupo `Readers` del proyecto del arnés. Sin esto, para esa identidad el
 *      proyecto entero NO EXISTE y el permiso 1 no tiene dónde aplicarse. Con el 1 solo, el
 *      pipeline falla con `TF401019: ... does not exist or you do not have permissions`, que se
 *      lee como "el repo no existe" y es "no podés ver el proyecto".
 *   3. CONTRIBUIR sobre los repos PROPIOS del producto: la corrida de `main` sube la versión con
 *      un commit y lo pushea. Sin esto falla con `TF401027: You need the Git 'GenericContribute'
 *      permission`, y falla al final, después de haber compilado y probado todo.
 *   4. SALTEAR LAS POLÍTICAS DE RAMA en esos mismos repos: ese commit de versión va DIRECTO a
 *      `main`, que tiene validación por build. Sin esto el push se rechaza igual, con otro error.
 *
 * Los permisos 3 y 4 son un solo número (4 + 128 = 132), que es exactamente lo que tienen los
 * productos que ya funcionan.
 *
 * 🔴 NO CABLEA NINGÚN IDENTIFICADOR. El de la colección sale de un miembro que ya está en el
 * grupo; los de proyectos y repos salen de sus nombres. Un guion con identificadores pegados
 * sirve en una organización y miente en la siguiente.
 *
 * 🔴 LA MISMA IDENTIDAD SE NOMBRA DE DOS MANERAS y cada API acepta sólo la suya. Pasarle a los
 * permisos el nombre del grafo devuelve HTTP 500 sin decir por qué (nos costó un rato):
 *     grafo (grupos):    svc.base64("<colección>:Build:<proyecto>")   sin el relleno '='
 *     permisos (listas): "Microsoft.TeamFoundation.ServiceIdentity;<colección>:Build:<proyecto>"
 *
 * 🔴 LA CONFIRMACIÓN NO ES INMEDIATA. Azure tarda unos segundos en reflejar un permiso recién
 * puesto: releer al toque dice que no está aunque esté. Por eso la verificación reintenta.
 *
 * 🔴 Es idempotente y NUNCA quita permisos: si algo ya está, lo dice y no lo toca.
 *
 * Uso:
 *   node grant-new-product-permissions.js --project "<nombre o id>" [--verify] [--json]
 *
 *   --verify           sólo mira y reporta; NO escribe nada. Empezá siempre por acá.
 *   --write-access a,b repos que reciben contribuir + saltear políticas: los que PUBLICAN VERSIÓN
 *                      (backend y formularios). Si no se pasa, esos dos permisos NO se tocan y el
 *                      guion lo dice: el repo de historias no los necesita —su pipeline sólo
 *                      revisa, no pushea— y repartirlos a todos es dar permiso de saltear las
 *                      políticas de rama donde no hace falta.
 *   --harness <nombre> proyecto del arnés (default: tycon-claude-guides)
 *   (--project, --verify, --write-access y --harness tenían nombre en castellano hasta la story 8.9, tanda B3a;
 *   los viejos siguen andando hasta el retiro)
 *   --repo <nombre>    repo del arnés (default: igual que el proyecto)
 *   --org <url>        default: `ado.org` de la configuración del arnés (TYCON_ADO_ORG, ~/.claude/tycon.json o
 *                      el perfil del equipo): sin ninguna, Azure DevOps está apagado en esta máquina y sale 2
 *
 * Necesita un PAT en AZURE_DEVOPS_EXT_PAT (o AZURE_DEVOPS_PAT) con permiso para administrar
 * identidades y permisos. Si no alcanza, cada error trae el camino por interfaz.
 *
 * Salida: 0 todo en su lugar · 1 falta algo y no se pudo poner · 2 no se pudo medir (o llegó una opción con su
 * nombre viejo y el nuevo a la vez).
 */

const NS_REPOS_GIT = '2e9eb7ed-3c0a-47d4-87c1-0ffdd275fd87'; // espacio de nombres "Git Repositories"
const LECTURA = 2;                 // GenericRead
const CONTRIBUIR = 4;              // GenericContribute
const SALTEAR_POLITICAS = 128;     // PolicyExempt — para el commit de versión que va directo a main
const ESCRITURA = CONTRIBUIR | SALTEAR_POLITICAS; // 132, lo mismo que tienen los productos que andan

// Las opciones renombradas a inglés (story 8.9, tanda B3a): el nombre viejo sigue andando hasta el retiro. El
// traductor vive al lado (viaja con este archivo en el artefacto arnes-ci).
const { aliasLegacyOptions, LegacyOptionsError } = (() => {
  try { return require('./legacy-options.js'); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') process.stderr.write(`⚠️  legacy-options.js no cargó (${e && e.message}): los nombres viejos de este guion no se traducen\n`); return { aliasLegacyOptions: (argv) => argv, LegacyOptionsError: Error }; }
})();
const args = (() => {
  try {
    return aliasLegacyOptions(process.argv.slice(2), 'arnes:harness escritura:write-access proyecto:project verificar:verify', 'scripts/ci/grant-new-product-permissions.js');
  } catch (e) {
    if (!(e instanceof LegacyOptionsError)) throw e;
    console.error(`✗ ${e.message}`);
    process.exit(2);
  }
})();
const flag = (n, d = null) => {
  const i = args.indexOf(n);
  return i === -1 ? d : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true);
};
// La organización: `--org`, o `ado.org` de la configuración del arnés (story 8.3), como open-prs.js. Una organización
// escrita acá sirve en un equipo y miente en el siguiente: la misma regla que los identificadores de arriba.
const ORG = (() => {
  const dada = flag('--org');
  if (dada && dada !== true) return String(dada).replace(/\/+$/, '');
  let ado;
  try {
    ado = require(require('path').join(__dirname, '..', 'lib', 'tycon-config.js')).integracionParaComando('ado');
  } catch (e) {
    console.error(`✗ la configuración del arnés no se deja leer: ${e.message}`);
    process.exit(2);
  }
  if (!ado.prendida) {
    console.error(`✗ ${ado.apagada} — o pasá la organización con --org <url>`);
    process.exit(2);
  }
  return String(ado.config.valores.ado.org).replace(/\/+$/, '');
})();
const ARNES_PROYECTO = String(flag('--harness', 'tycon-claude-guides'));
const ARNES_REPO = String(flag('--repo', ARNES_PROYECTO));
const PROYECTO = flag('--project');
const ESCRITURA_EN = flag('--write-access');
const SOLO_VERIFICAR = args.includes('--verify');
const JSON_OUT = args.includes('--json');

const PAT = process.env.AZURE_DEVOPS_EXT_PAT || process.env.AZURE_DEVOPS_PAT || '';
const ORG_NOMBRE = ORG.split('/').filter(Boolean).pop();
const VSSPS = `https://vssps.dev.azure.com/${ORG_NOMBRE}`;

const salida = { proyecto: PROYECTO, lectura_arnes: null, miembro_readers: null, escritura_propia: {}, acciones: [], notas: [] };

function morir(codigo, mensaje) {
  if (JSON_OUT) { salida.error = mensaje; console.log(JSON.stringify(salida, null, 1)); }
  else console.error(`✗ ${mensaje}`);
  process.exit(codigo);
}

async function api(url, { metodo = 'GET', cuerpo = null } = {}) {
  const r = await fetch(url, {
    method: metodo,
    headers: {
      Authorization: 'Basic ' + Buffer.from(':' + PAT).toString('base64'),
      'Content-Type': 'application/json',
    },
    body: cuerpo === null ? undefined : JSON.stringify(cuerpo),
  });
  const texto = await r.text();
  let datos = null;
  try { datos = texto ? JSON.parse(texto) : null; } catch { /* no era JSON */ }
  return { ok: r.ok, estado: r.status, datos, texto };
}

const motivo = (r) => (r.datos && r.datos.message) || String(r.texto || '').slice(0, 200);
const descriptorDeGrafo = (col, proy) =>
  'svc.' + Buffer.from(`${col}:Build:${proy}`).toString('base64').replace(/=+$/, '');
const descriptorDePermisos = (col, proy) =>
  `Microsoft.TeamFoundation.ServiceIdentity;${col}:Build:${proy}`;
const decodificar = (d) => {
  const b = d.split('.', 2)[1] || '';
  return Buffer.from(b + '='.repeat((4 - (b.length % 4)) % 4), 'base64').toString();
};
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// Lee los permisos de un repo y devuelve los bits que tiene la identidad de compilación del proyecto.
async function bitsDe(token, proyectoId) {
  const acl = await api(`${ORG}/_apis/accesscontrollists/${NS_REPOS_GIT}?token=${encodeURIComponent(token)}&api-version=7.1`);
  if (!acl.ok) return null;
  const aces = ((acl.datos.value || [])[0] || {}).acesDictionary || {};
  const e = Object.entries(aces).find(([d]) => d.includes(`:Build:${proyectoId}`));
  return e ? (e[1].allow || 0) : 0;
}

// Azure tarda unos segundos en reflejar lo recién escrito: releer al toque miente.
async function bitsConReintento(token, proyectoId, esperados) {
  for (const espera of [0, 1500, 3000, 5000]) {
    if (espera) await esperar(espera);
    const bits = await bitsDe(token, proyectoId);
    if (bits !== null && (bits & esperados) === esperados) return bits;
  }
  return await bitsDe(token, proyectoId);
}

(async () => {
  if (!PAT) morir(2, 'No hay PAT en AZURE_DEVOPS_EXT_PAT ni en AZURE_DEVOPS_PAT — sin eso no se puede ni mirar.');
  if (!PROYECTO || PROYECTO === true) morir(2, 'Falta --project "<nombre o id>".');

  // ── Identificadores, todos deducidos ────────────────────────────────────────────────────────
  const proy = await api(`${ORG}/_apis/projects/${encodeURIComponent(PROYECTO)}?api-version=7.1`);
  if (!proy.ok) morir(2, `No pude leer el proyecto "${PROYECTO}" (HTTP ${proy.estado}). El nombre va tal cual, con espacios.`);
  const proyectoId = proy.datos.id;

  const arnesProy = await api(`${ORG}/_apis/projects/${encodeURIComponent(ARNES_PROYECTO)}?api-version=7.1`);
  if (!arnesProy.ok) morir(2, `No pude leer el proyecto del arnés "${ARNES_PROYECTO}" (HTTP ${arnesProy.estado}).`);
  const repo = await api(`${ORG}/${encodeURIComponent(ARNES_PROYECTO)}/_apis/git/repositories/${encodeURIComponent(ARNES_REPO)}?api-version=7.1`);
  if (!repo.ok) morir(2, `No pude leer el repo del arnés "${ARNES_REPO}" (HTTP ${repo.estado}).`);
  const tokenArnes = `repoV2/${arnesProy.datos.id}/${repo.datos.id}`;

  const grupos = await api(`${VSSPS}/_apis/graph/groups?api-version=7.1-preview.1`);
  if (!grupos.ok) morir(2, `No pude listar los grupos (HTTP ${grupos.estado}). Si es 401 o 403, el PAT no alcanza para administrar identidades.`);
  const readers = (grupos.datos.value || []).find(
    (g) => String(g.principalName || '').toLowerCase() === `[${ARNES_PROYECTO}]\\readers`.toLowerCase());
  if (!readers) morir(2, `No encontré el grupo [${ARNES_PROYECTO}]\\Readers.`);

  const miembros = await api(`${VSSPS}/_apis/graph/memberships/${readers.descriptor}?direction=down&api-version=7.1-preview.1`);
  if (!miembros.ok) morir(2, `No pude listar los miembros de Readers (HTTP ${miembros.estado}).`);
  const svcs = (miembros.datos.value || []).map((m) => m.memberDescriptor).filter((d) => String(d).startsWith('svc.'));
  if (!svcs.length) morir(2, `Ninguna identidad de compilación es miembra de [${ARNES_PROYECTO}]\\Readers: no puedo deducir el identificador de la colección. La primera vez, hacelo por interfaz.`);
  const coleccion = decodificar(svcs[0]).split(':')[0];
  const dGrafo = descriptorDeGrafo(coleccion, proyectoId);
  const dPermisos = descriptorDePermisos(coleccion, proyectoId);

  // Los repos propios que reciben escritura.
  const reposProy = await api(`${ORG}/${encodeURIComponent(PROYECTO)}/_apis/git/repositories?api-version=7.1`);
  if (!reposProy.ok) morir(2, `No pude listar los repos de "${PROYECTO}" (HTTP ${reposProy.estado}).`);
  // 🔴 Sin --write-access NO se reparte escritura. Dársela a todos los repos del proyecto incluye
  // el de historias, que no la necesita, y "saltear políticas de rama" no se regala por comodidad.
  const pedidos = typeof ESCRITURA_EN === 'string'
    ? ESCRITURA_EN.split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  const propios = (reposProy.datos.value || []).filter((r) => pedidos.includes(r.name));
  const faltan = pedidos.filter((n) => !propios.some((r) => r.name === n));
  if (faltan.length) morir(2, `No existen en "${PROYECTO}": ${faltan.join(', ')}.`);
  if (!pedidos.length) {
    salida.notas.push(`Sin --write-access no se tocan los permisos 3 y 4. Los repos de "${proy.datos.name}" son: ${(reposProy.datos.value || []).map((r) => r.name).join(', ')} — pasá los que publican versión.`);
  }

  // ── Qué falta ───────────────────────────────────────────────────────────────────────────────
  const bitsArnes = await bitsDe(tokenArnes, proyectoId);
  salida.lectura_arnes = bitsArnes !== null && (bitsArnes & LECTURA) === LECTURA;
  salida.miembro_readers = svcs.some((d) => decodificar(d) === `${coleccion}:Build:${proyectoId}`);
  for (const r of propios) {
    const bits = await bitsDe(`repoV2/${proyectoId}/${r.id}`, proyectoId);
    salida.escritura_propia[r.name] = bits !== null && (bits & ESCRITURA) === ESCRITURA;
  }

  const falta = [];
  if (!salida.lectura_arnes) falta.push('lectura sobre el repo del arnés');
  if (!salida.miembro_readers) falta.push('pertenencia a Readers');
  const sinEscritura = Object.entries(salida.escritura_propia).filter(([, v]) => !v).map(([k]) => k);
  if (sinEscritura.length) falta.push(`escritura propia en ${sinEscritura.join(', ')}`);

  const reportar = () => {
    if (JSON_OUT) { console.log(JSON.stringify(salida, null, 1)); return; }
    const ok = (b) => (b ? 'sí' : 'NO');
    console.log(`${falta.length ? '⚠️ ' : '✅'} ${proy.datos.name}`);
    console.log(`   lectura del arnés: ${ok(salida.lectura_arnes)} · miembra de Readers: ${ok(salida.miembro_readers)}`);
    for (const [n, v] of Object.entries(salida.escritura_propia)) console.log(`   escribe en ${n}: ${ok(v)}`);
    salida.notas.forEach((n) => console.log(`   ${n}`));
  };

  if (SOLO_VERIFICAR || !falta.length) {
    reportar();
    if (!JSON_OUT && falta.length) console.log('   Corré este mismo guion sin --verify.');
    process.exit(falta.length ? 1 : 0);
  }

  // ── Poner lo que falta ──────────────────────────────────────────────────────────────────────
  // 🔴 EL ORDEN IMPORTA: primero el grupo. La identidad de compilación de un proyecto recién
  // creado puede no existir todavía para el sistema de permisos; entrar al grupo la materializa.
  if (!salida.miembro_readers) {
    const r = await api(`${VSSPS}/_apis/graph/memberships/${dGrafo}/${readers.descriptor}?api-version=7.1-preview.1`, { metodo: 'PUT', cuerpo: {} });
    salida.acciones.push({ que: 'pertenencia a Readers', estado: r.estado, ok: r.ok });
    if (!r.ok) salida.notas.push(`No pude agregarla al grupo (HTTP ${r.estado}) — ${motivo(r)}. Por interfaz: ${ARNES_PROYECTO} → Project Settings → Permissions → Readers → Members → Add → "${proy.datos.name} Build Service (${ORG_NOMBRE})".`);
  }

  if (!salida.lectura_arnes) {
    const r = await api(`${ORG}/_apis/accesscontrolentries/${NS_REPOS_GIT}?api-version=7.1`, {
      metodo: 'POST',
      cuerpo: { token: tokenArnes, merge: true, accessControlEntries: [{ descriptor: dPermisos, allow: LECTURA, deny: 0 }] },
    });
    salida.acciones.push({ que: 'lectura sobre el repo del arnés', estado: r.estado, ok: r.ok });
    if (!r.ok) salida.notas.push(`No pude dar la lectura (HTTP ${r.estado}) — ${motivo(r)}. Por interfaz: ${ARNES_PROYECTO} → Project Settings → Repositories → ${ARNES_REPO} → Security → "${proy.datos.name} Build Service (${ORG_NOMBRE})" → Read: Allow.`);
  }

  for (const r0 of propios) {
    if (salida.escritura_propia[r0.name]) continue;
    const r = await api(`${ORG}/_apis/accesscontrolentries/${NS_REPOS_GIT}?api-version=7.1`, {
      metodo: 'POST',
      cuerpo: { token: `repoV2/${proyectoId}/${r0.id}`, merge: true, accessControlEntries: [{ descriptor: dPermisos, allow: ESCRITURA, deny: 0 }] },
    });
    salida.acciones.push({ que: `escritura propia en ${r0.name}`, estado: r.estado, ok: r.ok });
    if (!r.ok) salida.notas.push(`No pude dar escritura en ${r0.name} (HTTP ${r.estado}) — ${motivo(r)}. Por interfaz: ${proy.datos.name} → Project Settings → Repositories → ${r0.name} → Security → "${proy.datos.name} Build Service (${ORG_NOMBRE})" → Contribute y "Bypass policies when pushing": Allow.`);
  }

  // ── Releer: lo que no se verificó, no está hecho (con paciencia: Azure tarda) ────────────────
  const bits2 = await bitsConReintento(tokenArnes, proyectoId, LECTURA);
  salida.lectura_arnes = bits2 !== null && (bits2 & LECTURA) === LECTURA;
  const m2 = await api(`${VSSPS}/_apis/graph/memberships/${readers.descriptor}?direction=down&api-version=7.1-preview.1`);
  salida.miembro_readers = m2.ok && (m2.datos.value || []).map((m) => m.memberDescriptor)
    .filter((d) => String(d).startsWith('svc.'))
    .some((d) => decodificar(d) === `${coleccion}:Build:${proyectoId}`);
  for (const r0 of propios) {
    const bits = await bitsConReintento(`repoV2/${proyectoId}/${r0.id}`, proyectoId, ESCRITURA);
    salida.escritura_propia[r0.name] = bits !== null && (bits & ESCRITURA) === ESCRITURA;
  }

  const listo = salida.lectura_arnes && salida.miembro_readers && Object.values(salida.escritura_propia).every(Boolean);
  reportar();
  if (listo && !JSON_OUT) console.log('   Probalo: corré el pipeline de integración del producto y mirá la etapa que baja el arnés.');
  process.exit(listo ? 0 : 1);
})().catch((e) => morir(2, `Se cayó: ${e && e.message ? e.message : e}`));
