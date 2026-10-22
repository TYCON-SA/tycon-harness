#!/usr/bin/env node
/**
 * adversarial-duplication.js — cuántos de los verificadores del pase adversarial reproducen algo que
 * otro verificador ya reprodujo, medido sobre la SERIE archivada y no sobre una corrida.
 *
 * 🔴 De dónde sale la pregunta: una corrida abrió 25 agentes y 2.668.124 tokens en el
 *    pase. 19 hallazgos confirmados que eran 9 problemas distintos → ~10 verificadores de más, el
 *    40 % del pase. Pero eso es n=1, y un ahorro prometido con n=1 es una estimación disfrazada.
 *
 * Cruza DOS fuentes, porque ninguna sola alcanza:
 *
 *   | Fuente | Qué aporta | Dónde vive |
 *   |---|---|---|
 *   | El buzón de corridas | CUÁNTOS hallazgos confirmó cada pase (`adversarialPasses[].confirmados`) | ~/.claude/.tycon-pipeline/corridas-buzon — 4 máquinas, 14 repos |
 *   | El volcado crudo del pase | los hallazgos ENTEROS, con lente, archivo y línea | `<corrida>/step-05b-adversarial.json` — NO viaja por git |
 *   | Los hallazgos consolidados | en cuántas CAUSAS los agrupó el orquestador | `<corrida>/findings.json` — SÍ viaja por git |
 *
 * 🔴 La honestidad de esta medición está en lo que declara, no en el número:
 *   · `fuente: 'crudo'` es la buena — el pase dijo cuántos hallazgos hubo y el volcado los trae.
 *   · `fuente: 'consolidado'` es un PROXY: cuenta las causas en las que el orquestador agrupó a mano
 *     al cerrar la corrida. Mide cuánto agrupó una persona, que es una cota de cuánto habría podido
 *     agrupar un criterio conservador — no la duplicación real. Hay corridas donde ese número da más
 *     causas que hallazgos (el reporte sumó hallazgos de otros revisores): esas se descartan.
 *   · un pase sin ninguna de las dos NO se estima: se cuenta aparte y el resumen lo dice.
 *
 * SÓLO LEE. No escribe en el buzón ni en las corridas archivadas.
 *
 * Uso:
 *   node scripts/metrics/adversarial-duplication.js [--mailbox <dir>] [--repos <d1,d2>] [--json] [--out <md>]
 */

'use strict';
// el piso de Node: con uno viejo, este guion se vuelve a lanzar con el Node del arnés o lo dice en una línea
if (require.main === module) { try { require('../lib/node-floor.js').guard(); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') throw e; } }

const fs = require('fs');
const os = require('os');
const path = require('path');
// La carpeta del estado la sabe scripts/setup/harness/tycon-home.js. Se carga SI ESTÁ, por su ruta: los
// laboratorios copian carpetas sueltas de scripts/ sin scripts/setup/; ahí vale la ruta de siempre, que es la misma (T5 de
// scripts/tests/tycon-home.test.js). Si está y no carga, tira.
const stateDirOf = (() => { const lib = path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js'); return require('fs').existsSync(lib) ? require(lib).stateDir : (h) => path.join(h || require('os').homedir(), '.claude', '.tycon-pipeline'); })();
const { execFileSync } = require('child_process');

const BUZON_DEFAULT = path.join(stateDirOf(os.homedir()), 'corridas-buzon');

// Con menos pases que esto, el porcentaje no se publica como número: se declara la muestra. El corte
// no es mágico — es el mínimo con el que la mediana deja de moverse entera por una sola corrida.
const MUESTRA_MINIMA = 5;

// 🔴 «No pude leer» NO es «no hay». El buzón lo escriben
// 4 máquinas: una escritura a medias es realista, no hipotética. Un archivo que NO EXISTE es un caso
// legítimo y sigue devolviendo null en silencio; cualquier otra cosa (JSON roto, permisos) se anota
// en `diag` y sale por stderr, para que el reporte pueda decir cuántos descartó por ilegibles.
function leerJson(f, diag) {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    if (diag) diag.ilegible(f, e && e.message ? e.message : String(e));
    return null;
  }
}

/** Acumulador de lo que no se pudo leer. Vive por corrida de `medir()`, no global. */
function nuevoDiag() {
  const lista = [];
  return {
    lista,
    ilegible(archivo, motivo) {
      // `findings.json` a secas se repite en TODAS las corridas: con dos rotas, el detalle mostraría
      // dos entradas idénticas y no se sabría cuáles. Se publica
      // «<carpeta de la corrida>/<archivo>», que identifica sin exponer la ruta de la máquina.
      const nombre = etiqueta(archivo);
      lista.push({ archivo: nombre, motivo });
      process.stderr.write(`[duplicacion-adversarial] ILEGIBLE ${nombre}: ${motivo}\n`);
    },
  };
}

// Las rutas del buzón son absolutas y traen el usuario de la máquina donde corrió (SEC-W8):
// al publicarlas se filtra el nombre de otro dev y el del proyecto/cliente. Se
// publica sólo el nombre de la carpeta, que alcanza para identificarla.
function corto(p) {
  return p ? path.basename(String(p)) : '';
}

/** Nombre publicable de un archivo: su carpeta inmediata + el archivo, sin la ruta de la máquina. */
function etiqueta(p) {
  if (!p) return '';
  const abs = String(p);
  return path.join(path.basename(path.dirname(abs)), path.basename(abs));
}

function caminar(dir, out, diag, raiz = true) {
  let e = [];
  // una carpeta de máquina que no se deja listar se DICE (sus pases faltan, no son cero); la raíz que no existe es
  // «buzón vacío»
  try { e = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (err) { if (diag && !(raiz && err && err.code === 'ENOENT')) diag.ilegible(dir, `la carpeta no se pudo listar (${(err && err.code) || 'error'})`); return out; }
  for (const it of e) {
    const p = path.join(dir, it.name);
    // `<maquina>/registros/` nunca trae volcados, y su place.json trae el correo de git de la persona
    if (it.isDirectory()) { if (it.name !== 'registros') caminar(p, out, diag, false); }
    else if (it.name.endsWith('.json')) out.push(p);
  }
  return out;
}

/** Los pases adversariales anotados en el buzón: uno por corrida que haya dejado `confirmados`. */
function leerPases(buzon, diag) {
  const pases = [];
  // La misma corrida puede estar en la carpeta vieja de una máquina y en la nueva
  // `<nombre>-<código>`, donde la volvió a subir: cuenta UNA vez (la sesión; sin sesión, el archivo y su fecha).
  const vistas = new Set();
  for (const f of caminar(buzon, [], diag)) {
    const d = leerJson(f, diag);
    if (!d || typeof d !== 'object' || !d.marker) continue;
    const clave = typeof d.marker.sessionId === 'string' && d.marker.sessionId ? `s:${d.marker.sessionId}` : `a:${path.basename(f)}|${d.archivedAt || ''}`;
    if (vistas.has(clave)) continue;
    const m = d.marker;
    const lista = Array.isArray(m.adversarialPasses) ? m.adversarialPasses : [];
    const conCuenta = lista.filter((p) => typeof p.confirmados === 'number');
    if (!conCuenta.length) continue;
    // vista recién cuando aporta un pase: una copia sin pases de la misma corrida no tapa a la que los tiene
    vistas.add(clave);
    // Una corrida puede anotar el mismo pase varias veces (re-anotación). Vale la anotación con más
    // confirmados: es el pase completo. 🔴 Y el par (hallazgos, causas) sale de ESA MISMA anotación —
    // tomar cada máximo por separado cruzaría los 20 hallazgos de un lanzamiento con las 2 causas de
    // otro, y daría un ratio que nunca existió.
    const elegida = conCuenta.reduce((a, b) => (b.confirmados > a.confirmados ? b : a));
    const hallazgos = elegida.confirmados;
    pases.push({
      volcado: f,
      story: String(m.storyId || ''),
      repoPath: String(m.repoPath || ''),
      startedAt: m.startedAt || d.archivedAt || null,
      hallazgos,
      // El propio pase anota las clases: cuando está, no hace falta ningún proxy.
      clases_declaradas: typeof elegida.clases === 'number' ? elegida.clases : null,
    });
  }
  return pases;
}

/** Las carpetas de corrida de una story dentro de un repo. */
function corridasDe(repo, story) {
  const base = path.join(repo, '.advisors', 'pipeline-runs');
  let e = [];
  try { e = fs.readdirSync(base, { withFileTypes: true }); } catch (_e) { return []; }
  // `<número>-<sello>` o, si el número se repite en el repo, `<tema>__<número>-<sello>`. El pase sólo
  // trae el número: se aceptan las dos formas para no quedar ciegos a las carpetas nuevas (es una medición, no un freno).
  return e.filter((it) => it.isDirectory() && (it.name.startsWith(`${story}-`) || it.name.includes(`__${story}-`))).map((it) => path.join(base, it.name));
}

function adversarialesDeFindings(arr) {
  if (!Array.isArray(arr)) return null;
  const adv = arr.filter((x) => x && typeof x === 'object' && /advers/i.test(String(x.advisor || '')));
  return adv.length ? adv.length : null;
}

/** Busca en el historial de git el findings.json de una corrida que ya no esté en el working tree. */
function findingsDesdeGit(repo, runDir, diag) {
  const rel = path.relative(repo, path.join(runDir, 'findings.json'));
  try {
    const sha = execFileSync('git', ['log', '--all', '--diff-filter=A', '--format=%H', '-1', '--', rel],
      { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (!sha) return null;
    const txt = execFileSync('git', ['show', `${sha}:${rel}`], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return JSON.parse(txt);
  } catch (e) {
    // Una carpeta que NO es un repo git es un caso legítimo (un worktree borrado, un directorio
    // suelto): no es «ilegible», es «no aplica». Cualquier otra falla —git roto, un JSON corrupto en
    // el historial— sí se anota: es la diferencia entre «no había» y «no pude leer».
    const txt = `${(e && e.message) || e}\n${(e && e.stderr) || ''}`;
    if (/not a git repository|no such file or directory/i.test(txt)) return null;
    if (diag) diag.ilegible(path.join(runDir, 'findings.json'), String((e && e.message) || e).split('\n')[0]);
    return null;
  }
}

/**
 * Para un pase, cuántas causas distintas hubo y de dónde salió el dato.
 * Devuelve { clases, fuente, corrida } o { motivo } si no se pudo medir.
 */
function clasesDelPase(pase, repos, diag) {
  if (typeof pase.clases_declaradas === 'number') {
    return { clases: pase.clases_declaradas, fuente: 'declarado', corrida: null };
  }
  // 🔴 El repo que el pase DECLARÓ manda. Buscar la story en todos los repos del buzón y desempatar
  // por fecha podría traer las causas de una corrida ajena con el mismo número de story.
  // Sólo si el repo declarado no está en esta máquina se mira en los demás.
  // 🔴 Y cuando NO está (el caso normal: el buzón lo escriben 4 máquinas y esas rutas no existen
  // acá), se busca en los repos locales igual —es la única fuente que hay— pero la fila queda MARCADA
  // como resuelta por coincidencia de número. Sin esa marca, una corrida ajena con el mismo número de
  // story aportaría causas que no son suyas y se vería igual de confiable que el resto.
  const declaradoExiste = Boolean(pase.repoPath && fs.existsSync(pase.repoPath));
  const declarado = declaradoExiste ? [pase.repoPath] : repos;
  const candidatos = [];
  for (const repo of declarado) {
    if (!fs.existsSync(repo)) continue;
    for (const c of corridasDe(repo, pase.story)) candidatos.push({ repo, corrida: c });
  }
  if (!candidatos.length) {
    const existe = pase.repoPath && fs.existsSync(pase.repoPath);
    return { motivo: existe ? 'la ejecución no dejó sus hallazgos en el repo' : `el repo de la ejecución no está en esta máquina (${corto(pase.repoPath) || 'sin declarar'})` };
  }
  // 🔴 Un pase lanzado temprano escribe en la carpeta de ESE momento y el reporte se consolida en la
  // de la corrida: la misma story deja DOS carpetas hermanas y sólo una tiene los datos.
  // Así que primero se descartan las carpetas vacías; recién entre las que tienen algo se
  // desempata por tiempo.
  const antesDelFiltro = diag ? diag.lista.length : 0;
  const conDatos = candidatos.filter((c) =>
    fs.existsSync(path.join(c.corrida, 'step-05b-adversarial.json')) ||
    fs.existsSync(path.join(c.corrida, 'findings.json')) ||
    findingsDesdeGit(c.repo, c.corrida, diag));
  if (!conDatos.length) {
    // Si el filtro de arriba ya anotó un ilegible, la corrida SÍ dejó algo — ilegible. Decir «no
    // dejó nada» acá es el mismo error que se evita a nivel de resumen, repetido por fila.
    if (diag && diag.lista.length > antesDelFiltro) {
      return { motivo: `la ejecución dejó sus archivos pero son ILEGIBLES: ${diag.lista[diag.lista.length - 1].motivo}` };
    }
    return { motivo: 'la ejecución existe pero no dejó ni el volcado del pase ni sus hallazgos consolidados' };
  }
  candidatos.length = 0;
  candidatos.push(...conDatos);

  // Varias corridas de la misma story CON datos: la más cercana al arranque del pase. Si no hay con
  // qué desempatar, no se elige una a dedo — se declara y listo.
  let elegido = candidatos[0];
  if (candidatos.length > 1) {
    const ts = pase.startedAt ? Date.parse(pase.startedAt) : NaN;
    if (!Number.isFinite(ts)) return { motivo: `${candidatos.length} ejecuciones de la story ${pase.story} y el volcado no dice cuál` };
    let mejor = null;
    for (const c of candidatos) {
      let m = null;
      try { m = fs.statSync(c.corrida).mtimeMs; } catch (_e) { continue; }
      const d = Math.abs(m - ts);
      if (!mejor || d < mejor.d) mejor = { ...c, d };
    }
    if (!mejor) return { motivo: `${candidatos.length} ejecuciones de la story ${pase.story} y ninguna legible` };
    elegido = mejor;
  }

  const antes = antesDelFiltro;
  const crudo = leerJson(path.join(elegido.corrida, 'step-05b-adversarial.json'), diag);
  if (crudo && Array.isArray(crudo.confirmed) && crudo.confirmed.length) {
    // 🔴 Si el pase ya anotó en cuántas causas agrupó, ESE es el número: re-aplicar el criterio sobre
    // `confirmed` mide sobre el subconjunto YA FILTRADO por veredicto, que no es lo que el pase vivió
    // Sólo se re-agrupa cuando el volcado es viejo y no lo trae.
    if (typeof crudo.clases === 'number') {
      return { clases: crudo.clases, fuente: 'crudo', corrida: elegido.corrida, repo: elegido.repo, repo_confirmado: declaradoExiste };
    }
    return { clases: null, crudos: crudo.confirmed, fuente: 'crudo', corrida: elegido.corrida, repo: elegido.repo, repo_confirmado: declaradoExiste };
  }
  const fj = leerJson(path.join(elegido.corrida, 'findings.json'), diag) || findingsDesdeGit(elegido.repo, elegido.corrida, diag);
  const n = adversarialesDeFindings(fj);
  if (n) return { clases: n, fuente: 'consolidado', corrida: elegido.corrida, repo: elegido.repo, repo_confirmado: declaradoExiste };
  // Si algo se rompió al leer, el motivo lo DICE: «no dejó nada» y «dejó algo ilegible» son cosas
  // distintas y sólo una de las dos es culpa de la corrida.
  if (diag && diag.lista.length > antes) {
    return { motivo: `la ejecución dejó sus archivos pero son ILEGIBLES: ${diag.lista[diag.lista.length - 1].motivo}` };
  }
  return { motivo: 'la ejecución existe pero no dejó ni el volcado del pase ni sus hallazgos consolidados' };
}

function percentil(xs, p) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo);
}

/**
 * La medición. `agrupador` es opcional: si se le pasa el criterio de `group-findings.js`, las
 * filas con volcado crudo se miden aplicándoselo de verdad, en vez de con el proxy consolidado.
 */
function medir(opts) {
  const o = opts || {};
  const buzon = o.buzon || BUZON_DEFAULT;
  const diag = nuevoDiag();
  const pases = leerPases(buzon, diag);
  // Las rutas se usan enteras para BUSCAR en disco, pero lo que se DEVUELVE va acortado: el objeto
  // de `medir()` es lo que sale por `--json` y lo consume otro script (SEC-W8). Taparlo
  // sólo al renderizar la tabla no es taparlo.
  const repos = [...new Set([...(o.repos || []), ...pases.map((p) => p.repoPath).filter(Boolean)])];
  const reposPublicables = repos.map(corto);
  const agrupador = o.agrupador || null;

  const filas = [];
  let limpios = 0;
  for (const p of pases) {
    // 🔴 Un pase que confirmó 0 hallazgos es un dato COMPLETO y legítimo (las 6 lentes salieron
    // limpias). No aporta al ratio —no hay nada que agrupar— pero no es «no pude medir»: mezclarlo
    // con los ilegibles ensucia justo el número que esta medición existe para publicar.
    if (p.hallazgos === 0) {
      limpios++;
      filas.push({ story: p.story, repo: corto(p.repoPath), hallazgos: 0, clases: 0, ratio: null, fuente: 'declarado', medible: false, motivo: 'el pase salió limpio (0 hallazgos): no aporta al ratio' });
      continue;
    }
    const c = clasesDelPase(p, repos, diag);
    if (c.motivo) { filas.push({ story: p.story, repo: corto(p.repoPath), hallazgos: p.hallazgos, clases: null, ratio: null, fuente: null, medible: false, motivo: c.motivo }); continue; }

    let clases = c.clases;
    let fuente = c.fuente;
    if (fuente === 'crudo' && Array.isArray(c.crudos)) {
      // Con los hallazgos enteros se puede aplicar el criterio de verdad. Sin criterio a mano, se
      // usa la cantidad de sitios distintos (archivo+línea), que es su cota inferior de agrupación.
      // (Si el volcado ya trajo su `clases`, no se llega acá: vale lo que el pase midió en vivo.)
      if (agrupador) clases = agrupador(c.crudos).clases.length;
      else clases = new Set(c.crudos.map((f) => `${f.file}:${f.line === null || f.line === undefined ? '?' + Math.random() : f.line}`)).size;
    }
    if (!clases || clases > p.hallazgos) {
      filas.push({
        story: p.story, repo: corto(p.repoPath), hallazgos: p.hallazgos, clases: null, ratio: null, fuente, medible: false,
        motivo: clases ? `el consolidado trae ${clases} entradas del pase y el buzón dice ${p.hallazgos} hallazgos: no cuadran, no se estima` : 'sin causas legibles',
      });
      continue;
    }
    filas.push({
      story: p.story, repo: corto(p.repoPath), hallazgos: p.hallazgos, clases, ratio: p.hallazgos / clases,
      fuente, corrida: corto(c.corrida), medible: true,
      repo_confirmado: c.repo_confirmado !== false,
      ...(c.repo_confirmado === false ? { nota: 'el repo declarado no está en esta máquina: la ejecución se resolvió por coincidencia de número de story' } : {}),
    });
  }

  const ok = filas.filter((f) => f.medible);
  const ratios = ok.map((f) => f.ratio);
  const sumH = ok.reduce((a, f) => a + f.hallazgos, 0);
  const sumC = ok.reduce((a, f) => a + f.clases, 0);

  return {
    buzon,
    repos: reposPublicables,
    pases: pases.length,
    // Lo que NO se pudo leer se cuenta aparte de lo que no existe: un archivo roto que se descarta
    // en silencio convierte «no pude preguntar» en «pregunté y no hay».
    ilegibles: diag.lista.length,
    ilegibles_detalle: diag.lista,
    medidos: ok.length,
    // Un pase que salió limpio es un dato, no una falta de dato: se cuenta aparte de los dos.
    limpios,
    sin_datos: filas.length - ok.length - limpios,
    filas,
    muestra_minima: MUESTRA_MINIMA,
    muestra_suficiente: ok.length >= MUESTRA_MINIMA,
    estadisticas: {
      mediana: percentil(ratios, 0.5),
      p25: percentil(ratios, 0.25),
      p75: percentil(ratios, 0.75),
      hallazgos_totales: sumH,
      clases_totales: sumC,
      ahorro_pct: sumH ? ((sumH - sumC) / sumH) * 100 : 0,
      por_fuente: ok.reduce((a, f) => { a[f.fuente] = (a[f.fuente] || 0) + 1; return a; }, {}),
    },
  };
}

function n2(x) { return x === null || x === undefined ? '—' : (Math.round(x * 100) / 100).toString(); }

function resumen(r) {
  const e = r.estadisticas;
  const lineas = [];
  lineas.push(`Pases adversariales anotados en el buzón: ${r.pases}. Medidos: ${r.medidos} de ${r.pases}.`);
  if (r.limpios) lineas.push(`${r.limpios} pase(s) salieron LIMPIOS (0 hallazgos): dato válido, pero no aportan al ratio.`);
  if (r.ilegibles) {
    lineas.push(`🔴 ${r.ilegibles} archivo(s) ILEGIBLE(S) — no es lo mismo que «no había datos»:`);
    for (const x of r.ilegibles_detalle) lineas.push(`  · ${x.archivo} — ${x.motivo}`);
  }
  if (r.sin_datos) {
    lineas.push(`Quedaron afuera ${r.sin_datos} (sin datos, no medidos — no se estiman):`);
    for (const f of r.filas.filter((x) => !x.medible)) lineas.push(`  · story ${f.story} (${f.hallazgos} hallazgos) — ${f.motivo}`);
  }
  if (!r.medidos) {
    lineas.push('🔴 No se pudo medir ningún pase: no hay número que publicar.');
    return lineas.join('\n');
  }
  lineas.push(`Ratio hallazgos/causas — mediana ${n2(e.mediana)} · p25 ${n2(e.p25)} · p75 ${n2(e.p75)}.`);
  lineas.push(`Sobre lo medido: ${e.hallazgos_totales} hallazgos en ${e.clases_totales} causas → ${n2(e.ahorro_pct)} % de los verificadores sobran.`);
  lineas.push(`Fuente de las causas: ${Object.entries(e.por_fuente).map(([k, v]) => `${v} ${k}`).join(', ')}.`);
  const porCoincidencia = r.filas.filter((f) => f.medible && f.repo_confirmado === false);
  if (porCoincidencia.length) {
    lineas.push(`🔶 En ${porCoincidencia.length} de las ${r.medidos} filas medidas el repo declarado NO está en esta máquina y la` +
      ` ejecución se resolvió por COINCIDENCIA de número de story (${porCoincidencia.map((f) => f.story).join(', ')}).` +
      ` Si dos repos usan el mismo número, esas causas podrían no ser las suyas.`);
  }
  if (!r.muestra_suficiente) {
    lineas.push(`🔴 La muestra NO alcanza para sostener ese porcentaje: ${r.medidos} pase(s) medido(s), mínimo ${r.muestra_minima}.` +
      (r.medidos === 1 ? ' Con n=1 el número es una anécdota, no una medición: queda declarado así, y las ejecuciones futuras anotan sus causas solas (`mark-adversarial-result --classes`).' : ''));
  }
  return lineas.join('\n');
}

function tabla(r) {
  const filas = ['| story | repo | hallazgos | causas | ratio | fuente |', '|---|---|---|---|---|---|'];
  for (const f of r.filas) {
    filas.push(`| ${f.story} | ${f.repo || '—'} | ${f.hallazgos} | ${f.medible ? f.clases : '—'} | ${f.medible ? n2(f.ratio) : '—'} | ${f.medible ? f.fuente : 'no medido: ' + f.motivo} |`);
  }
  return filas.join('\n');
}

// El criterio de agrupación vive en agent-skills, que se actualiza con otro pull: su archivo se busca por el nombre actual y,
// si esa copia es anterior al renombre, por el nombre anterior —que sale del mapa de renombres, nunca
// escrito acá (guides/maintaining/nombres-en-ingles.md, «Entre repos»)—. Sin mapa (la copia pública) sólo vale el actual.
const CRITERIO = 'group-findings.js';
const CARPETA_DEL_CRITERIO = ['skills', 'tycon-pipeline', 'scripts', 'lib'];
/** La ruta del criterio en `dir` (default: el agent-skills de la máquina), o null si no está. */
function rutaDelCriterio(dir) {
  const carpeta = dir || path.join(os.homedir(), '.claude', 'agent-skills', ...CARPETA_DEL_CRITERIO);
  const nombres = [CRITERIO];
  try {
    const legacy = require('../lib/legacy-names.js');
    const nueva = [...CARPETA_DEL_CRITERIO, CRITERIO].join('/');
    for (const e of legacy.usableEntries(legacy.loadMap())) if (e.kind === 'file' && e.repo === 'agent-skills' && e.new === nueva) nombres.push(path.posix.basename(e.old));
  } catch (_) { /* sin la biblioteca al lado: el nombre de hoy */ }
  return nombres.map((n) => path.join(carpeta, n)).find((p) => fs.existsSync(p)) || null;
}
/**
 * La función que agrupa, o null. Sin el criterio a mano la medición sigue, con la cota por sitio — pero se AVISA, también
 * cuando el archivo no está: un cambio silencioso de método cambia el número sin que nadie lo note.
 */
function cargarCriterio(dir, avisar = (m) => process.stderr.write(`${m}\n`)) {
  const lib = rutaDelCriterio(dir);
  if (!lib) {
    avisar(`[duplicacion-adversarial] no encontré el criterio de agrupación (${CRITERIO}, en agent-skills); mido los crudos por sitio, que es su cota inferior`);
    return null;
  }
  let agrupar;
  try { agrupar = require(lib).agrupar; } catch (e) {
    avisar(`[duplicacion-adversarial] no pude cargar el criterio de agrupación (${e.message}); mido los crudos por sitio, que es su cota inferior`);
    return null;
  }
  if (typeof agrupar !== 'function') {
    avisar(`[duplicacion-adversarial] el criterio de agrupación (${lib}) no trae la función agrupar; mido los crudos por sitio, que es su cota inferior`);
    return null;
  }
  return agrupar;
}

function main(argv) {
  const flag = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const agrupador = cargarCriterio();
  const r = medir({ buzon: flag('--mailbox'), repos: (flag('--repos', '') || '').split(',').map((s) => s.trim()).filter(Boolean), agrupador });
  if (argv.includes('--json')) { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); return 0; }
  const texto = `${resumen(r)}\n\n${tabla(r)}\n`;
  const out = flag('--out');
  if (out) { fs.writeFileSync(out, texto); process.stdout.write(`escrito en ${out}\n`); } else process.stdout.write(texto);
  return 0;
}

module.exports = { medir, resumen, tabla, leerPases, clasesDelPase, rutaDelCriterio, cargarCriterio, MUESTRA_MINIMA, corridasDe };

if (require.main === module) {
  require('../lib/legacy-names.js').aliasArgv('scripts/metrics/adversarial-duplication.js', { prefix: '[duplicacion-adversarial] ' });
  process.exit(main(process.argv.slice(2)));
}
