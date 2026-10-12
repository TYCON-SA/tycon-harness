'use strict';
/**
 * Las reglas del repo que el revisor verifica (story 7.5, 2026-09-19).
 *
 * Cada repo de producto declara sus reglas de revisión en una sección fija de su `CLAUDE.md`:
 * `## Reglas para revisores`. Esta lib la recorta para que `pipeline.js` la pegue al principio del
 * contexto de cada revisor, marcada como «reglas a verificar».
 *
 * Por qué pegada y no leída: con el `CLAUDE.md` entero cargado, el revisor VE la regla pero no la
 * controla — 10 de 20 violaciones plantadas detectadas; con la sección pegada como reglas a
 * verificar, 17 de 20 (~/.claude/tycon-harness/tasks/medicion-7.5-reglas-para-revisores-2026-09-19.md §5).
 *
 * Nunca tira: lo que no se pudo leer vuelve como `estado: 'no_medido'` con su motivo, para que el
 * pipeline lo diga en vez de tratarlo como «el repo no tiene reglas».
 *
 * Estados: 'presente' · 'ausente' (hay CLAUDE.md, no hay sección) · 'vacia' (la sección no trae
 * texto) · 'sin_claude_md' · 'no_medido'.
 */
const fs = require('fs');
const path = require('path');

const TECHO_BYTES = 4000;
const ENCABEZADO_RE = /^##\s+Reglas para revisores\s*$/;
const CORTE_RE = /^#{1,2}\s/;
const CERCA_RE = /^\s*(```|~~~)/;
const ARCHIVOS = ['CLAUDE.md', path.join('.claude', 'CLAUDE.md')];

/**
 * Índice (0-based) de la línea del encabezado, o -1. Un encabezado dentro de una cerca de código
 * (un ejemplo de cómo se escribe la sección) no cuenta. Pero si el archivo tiene una cerca SIN CERRAR,
 * el estado de cerca ya no es confiable y una cerca abierta en una sección anterior escondería la
 * sección real (hallazgo del pase adversarial de la 7.5): en ese caso se busca el encabezado sin
 * mirar cercas. Mismo criterio en `scripts/ci/reviewer-rules.js` del arnés.
 */
function lineaDelEncabezado(lineas) {
  let enCerca = false;
  for (let i = 0; i < lineas.length; i++) {
    if (CERCA_RE.test(lineas[i])) { enCerca = !enCerca; continue; }
    if (!enCerca && ENCABEZADO_RE.test(lineas[i])) return i;
  }
  if (!enCerca) return -1;
  return lineas.findIndex((l) => ENCABEZADO_RE.test(l));
}

/** Recorta la sección de un markdown. Devuelve el texto (con el encabezado) o null si no está. */
function recortar(md) {
  const lineas = md.split(/\r?\n/);
  const desde = lineaDelEncabezado(lineas);
  if (desde < 0) return null;
  const out = [lineas[desde]];
  let enCerca = false; // dentro de la sección el estado de cerca arranca de cero
  for (const l of lineas.slice(desde + 1)) {
    if (CERCA_RE.test(l)) enCerca = !enCerca;
    else if (!enCerca && CORTE_RE.test(l)) break;
    out.push(l);
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.join('\n');
}

/**
 * @param {string} repo raíz del repo
 * @returns {{estado: string, texto?: string, bytes?: number, fuente?: string, fuentes?: string[],
 *            excede_techo?: boolean, motivo?: string}}
 */
function reglasRevisores(repo) {
  try {
    if (!repo || typeof repo !== 'string') return { estado: 'no_medido', motivo: 'sin ruta de repo' };
    const secciones = [];
    let hayArchivo = false;
    let haySeccion = false;
    for (const rel of ARCHIVOS) {
      const abs = path.join(repo, rel);
      if (!fs.existsSync(abs)) continue;
      hayArchivo = true;
      let md;
      try {
        md = fs.readFileSync(abs, 'utf8');
      } catch (e) {
        return { estado: 'no_medido', motivo: `no se pudo leer ${rel}: ${e.code || e.message}` };
      }
      const s = recortar(md);
      if (s === null) continue;
      haySeccion = true;
      const cuerpo = s.split('\n').slice(1).join('\n');
      if (cuerpo.trim()) secciones.push({ rel, texto: s });
    }
    if (!hayArchivo) return { estado: 'sin_claude_md' };
    if (!haySeccion) return { estado: 'ausente' };
    if (!secciones.length) return { estado: 'vacia' };
    const fuentes = secciones.map((s) => s.rel);
    const texto = secciones.length === 1
      ? secciones[0].texto
      : secciones.map((s) => `${s.texto}\n\n(fuente: ${s.rel})`).join('\n\n');
    const bytes = Buffer.byteLength(texto, 'utf8');
    return { estado: 'presente', texto, bytes, fuente: fuentes.join(' + '), fuentes, excede_techo: bytes > TECHO_BYTES };
  } catch (e) {
    return { estado: 'no_medido', motivo: e && e.message ? e.message : String(e) };
  }
}

/** El bloque que va al principio del contexto de cada revisor, o '' si no hay reglas. */
function bloqueParaContexto(reglas) {
  if (!reglas || reglas.estado !== 'presente') return '';
  return [
    `## Reglas propias de este repo — verificalas en el diff (fuente: ${reglas.fuente})`,
    '',
    reglas.texto,
    '',
    'Tratalas como reglas a verificar además de las tuyas: un incumplimiento es un hallazgo.',
    '',
    '',
  ].join('\n');
}

/** Lo que va en el JSON de `pipeline.js advisors`: el estado sin el texto. */
function resumen(reglas) {
  const r = reglas || { estado: 'no_medido', motivo: 'sin lectura' };
  const out = { estado: r.estado };
  if (r.estado === 'presente') {
    out.bytes = r.bytes;
    out.fuente = r.fuente;
    out.excede_techo = r.excede_techo;
  }
  if (r.motivo) out.motivo = r.motivo;
  return out;
}

module.exports = { reglasRevisores, bloqueParaContexto, resumen, recortar, TECHO_BYTES };
