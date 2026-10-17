#!/usr/bin/env node
/**
 * state-age.js — cuántas stories llevan más de N días paradas en su estado, por producto y estado (story 2.26).
 *
 * La auditoría de los tableros del 2026-10-15 encontró más de cien stories en revisión y una página que no decía
 * cuántas llevaban semanas ahí. El dato ya está en cada foto por proyecto (`dias_en_estado`, story 2.20, calculado con
 * las transiciones del medidor): acá sólo se suma. Sin medir nada de nuevo y sin escribir nada.
 *
 *   stateAge({ photosDir, products, today, dias }) →
 *     { estado: 'medido' | 'no_medido', motivo, dias, productos: [...], titular: {...}, no_medidos: [{ foto, motivo }] }
 *
 *   - `products`: el `repos.json` de la organización ({ repos: [...] } o la lista). El producto de una foto es el de las
 *     entradas cuyo proyecto de Azure DevOps (el tramo de `ado` antes de `/`, decodificado) coincide con su `proyecto`.
 *     Sin entrada, la foto cuenta con el nombre de su proyecto y `sin_producto_declarado: true`; con entradas de dos
 *     productos, cuenta en cada uno con `compartido_con: N`, y el titular la cuenta una vez (la regla de la 2.23).
 *   - `dias`: `sources.json → params.edad_en_estado_dias`, dos enteros crecientes. Sin ellos, «no medido»: ningún
 *     umbral escrito en el código.
 *   - Por producto y estado canónico: `total`, `mas_de_<d1>`, `mas_de_<d2>` (estrictamente más) y `sin_dato`. Las del
 *     grupo `cerrado` y `sin_entrega` no cuentan; las `desconocido`, sólo en `desconocido`. Una story con
 *     `dias_en_estado: null` va a `sin_dato`, nunca a «menos de N»: «no medido» no es cero.
 *   - `paradas` (en curso con más del primer umbral) y `sin_medir` (en curso sin dato): la definición de «parada» que
 *     usa el sitio de la organización (story 2.23), en un solo lugar.
 *   - El titular suma sólo lo empezado (grupos `en_curso` y `bloqueado`): una story de backlog vieja no está parada.
 *   - Una foto de más de 2 días antes de `today`, o ilegible, es «no medido» para ese repo, con su motivo.
 *   - Sólo conteos: ningún id, título ni ruta de story sale de acá.
 *
 * CLI (sólo lee): node state-age.js --photos <dir> [--products <repos.json>] [--sources <sources.json>] [--today AAAA-MM-DD]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const MAX_EDAD_FOTO_DIAS = 2;
const NO_CUENTAN = new Set(['cerrado', 'sin_entrega']);
const EMPEZADO = new Set(['en_curso', 'bloqueado']);

const dia = (s) => String(s || '').slice(0, 10);
function diasEntre(a, b) {
  const x = Date.parse(`${dia(a)}T00:00:00Z`); const y = Date.parse(`${dia(b)}T00:00:00Z`);
  return Number.isFinite(x) && Number.isFinite(y) ? Math.round((y - x) / 86400000) : null;
}
function proyectoDe(ado) {
  const tramo = String(ado || '').split('/')[0];
  if (!tramo) return null;
  try { return decodeURIComponent(tramo); } catch { return tramo; }
}
function diasValidos(d) {
  return Array.isArray(d) && d.length === 2 && d.every((x) => Number.isInteger(x) && x > 0) && d[0] < d[1];
}
function listaDeRepos(products) {
  if (!products) return null;
  if (Array.isArray(products)) return products;
  return Array.isArray(products.repos) ? products.repos : null;
}

function stateAge({ photosDir, products, today, dias } = {}) {
  const base = { dias: diasValidos(dias) ? dias : null, productos: [], titular: null, no_medidos: [] };
  if (!diasValidos(dias)) {
    return { ...base, estado: 'no_medido', motivo: 'sin params.edad_en_estado_dias válido en sources.json (dos enteros crecientes, por ejemplo [30, 60])' };
  }
  const [d1, d2] = dias;
  const k1 = `mas_de_${d1}`; const k2 = `mas_de_${d2}`;
  let archivos = [];
  try { archivos = fs.readdirSync(photosDir).filter((f) => f.endsWith('.json')).sort(); } catch (e) {
    // «no pude mirar» no es «no hay» (revisor de fallas silenciosas): sólo una carpeta que no existe es «no hay fotos»
    if (e && e.code !== 'ENOENT') return { ...base, estado: 'no_medido', motivo: `no pude leer la carpeta de fotos (${e.code || e.name})` };
    archivos = [];
  }
  if (!archivos.length) return { ...base, estado: 'no_medido', motivo: 'no hay fotos por proyecto' };

  const repos = listaDeRepos(products);
  // proyecto → productos declarados
  const porProyecto = new Map();
  for (const r of repos || []) {
    const p = proyectoDe(r && r.ado);
    if (!p || !r.producto) continue;
    if (!porProyecto.has(p)) porProyecto.set(p, new Set());
    porProyecto.get(p).add(r.producto);
  }
  // Las claves separan lo declarado de lo que no: un proyecto sin declarar que se llama como un producto declarado de
  // otro proyecto sale aparte, nunca mezclado con él (pase adversarial).
  const productos = new Map();   // `p:<producto>` | `s:<proyecto>` → acumulado
  const nuevo = (nombre, extra) => ({ producto: nombre, ...extra, fotos: 0, por_estado: {}, desconocido: 0, paradas: 0, sin_medir: 0, repos_no_medidos: [] });
  for (const nombre of new Set((repos || []).map((r) => r && r.producto).filter(Boolean))) productos.set(`p:${nombre}`, nuevo(nombre, {}));
  const destinosDe = (proyecto) => {
    const declarados = porProyecto.get(proyecto);
    if (declarados && declarados.size) {
      return [...declarados].map((nombre) => {
        if (!productos.has(`p:${nombre}`)) productos.set(`p:${nombre}`, nuevo(nombre, {}));
        const p = productos.get(`p:${nombre}`);
        if (declarados.size > 1) p.compartido_con = declarados.size;
        return p;
      });
    }
    if (!productos.has(`s:${proyecto}`)) productos.set(`s:${proyecto}`, nuevo(proyecto, { sin_producto_declarado: true }));
    return [productos.get(`s:${proyecto}`)];
  };

  const titular = { [k1]: 0, [k2]: 0, con_dato: 0, sin_dato: 0 };
  const no_medidos = [];
  for (const f of archivos) {
    let doc = null;
    try { doc = JSON.parse(fs.readFileSync(path.join(photosDir, f), 'utf8')); } catch { doc = null; }
    // el proyecto y el repo, de la foto o —si no se lee— del nombre del archivo (`<Proyecto>__<Repo>.json`)
    const [pNombre, rNombre] = f.replace(/\.json$/, '').split('__');
    const proyecto = (doc && doc.proyecto) || pNombre;
    const repo = `${proyecto}/${(doc && doc.repo) || rNombre || ''}`;
    let motivo = null;
    if (!doc || !Array.isArray(doc.stories)) motivo = 'foto ilegible';
    else {
      const edad = diasEntre(doc.generated_at, today);
      if (edad === null) motivo = 'foto sin fecha de generación';
      else if (edad > MAX_EDAD_FOTO_DIAS) motivo = `foto vieja, del ${dia(doc.generated_at)}`;
    }
    const destinos = destinosDe(proyecto);
    if (motivo) {
      // no suma, pero su producto lo sabe: «no medido» con ESTE motivo, o medido diciendo qué repo le falta
      no_medidos.push({ foto: f, motivo });
      for (const p of destinos) p.repos_no_medidos.push({ repo, motivo });
      continue;
    }
    for (const p of destinos) p.fotos++;
    for (const s of doc.stories) {
      if (!s || NO_CUENTAN.has(s.grupo)) continue;
      const d = Number.isInteger(s.dias_en_estado) ? s.dias_en_estado : null;
      if (s.grupo === 'desconocido' || !s.canonico) { for (const p of destinos) p.desconocido++; continue; }
      for (const p of destinos) {
        const c = p.por_estado[s.canonico] || (p.por_estado[s.canonico] = { total: 0, [k1]: 0, [k2]: 0, sin_dato: 0 });
        c.total++;
        if (d === null) c.sin_dato++;
        else { if (d > d1) c[k1]++; if (d > d2) c[k2]++; }
        if (s.grupo === 'en_curso') { if (d === null) p.sin_medir++; else if (d > d1) p.paradas++; }
      }
      // el titular cuenta cada story una vez, aunque su proyecto sea de dos productos
      if (EMPEZADO.has(s.grupo)) {
        if (d === null) titular.sin_dato++;
        else { titular.con_dato++; if (d > d1) titular[k1]++; if (d > d2) titular[k2]++; }
      }
    }
  }
  const lista = [...productos.values()].map((p) => {
    const { fotos, ...resto } = p;
    if (fotos > 0) return { ...resto, estado: 'medido', motivo: null };
    const motivos = [...new Set(p.repos_no_medidos.map((x) => x.motivo))];
    return { ...resto, estado: 'no_medido', motivo: motivos.length ? motivos.join('; ') : 'sin foto por proyecto' };
  }).sort((a, b) => a.producto.localeCompare(b.producto) || Number(!!a.sin_producto_declarado) - Number(!!b.sin_producto_declarado));
  const algunaMedida = lista.some((p) => p.estado === 'medido');
  titular.texto = `${titular[k1]} stories en curso llevan más de ${d1} días en su estado · ${titular[k2]} más de ${d2} — de ${titular.con_dato} con dato · ${titular.sin_dato} sin dato`;
  return {
    ...base,
    estado: algunaMedida ? 'medido' : 'no_medido',
    motivo: algunaMedida ? null : 'ninguna foto por proyecto al día',
    productos: lista,
    titular: algunaMedida ? titular : null,
    no_medidos,
  };
}

module.exports = { stateAge, MAX_EDAD_FOTO_DIAS };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const leer = (f) => { try { return f ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; } catch (e) { console.error(`state-age.js: no pude leer ${f}: ${e.code || e.message}`); process.exit(2); } return null; };
  if (!opt('--photos')) { console.error('uso: state-age.js --photos <dir> [--products <repos.json>] [--sources <sources.json>] [--today AAAA-MM-DD]'); process.exit(1); }
  // los días salen de sources.json (el del arnés si no se pasa otro): nunca un umbral escrito acá
  const src = leer(opt('--sources') || path.join(__dirname, '..', 'dashboard', 'sources.json'));
  const r = stateAge({ photosDir: opt('--photos'), products: leer(opt('--products')), today: opt('--today') || process.env.TYCON_TODAY || new Date().toISOString().slice(0, 10),
    dias: src && src.params ? src.params.edad_en_estado_dias : undefined });
  console.log(JSON.stringify(r, null, 2));
}
