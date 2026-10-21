#!/usr/bin/env node
/**
 * dashboard-notice.js — el tablero del arnés dice de cuándo es y si salió completo.
 *
 * Hook SessionStart. La página `artifacts/tablero-del-arnes.html` la genera el nocturno de Azure
 * (`pipelines/azure-pipelines-tablero.yml`) y trae adentro un sello con su fecha (`scripts/nightly/dashboard/seal.js`). Este aviso lo lee
 * y dice, en UNA línea:
 *
 *   · 🔕 si la página tiene MÁS DE DOS DÍAS, no dice de cuándo es o no está publicada: denuncia y CALLA sus números.
 *     Una foto vieja tranquiliza sobre lo que se rompió después, o hace perseguir algo que ya se arregló.
 *   · 🟡 si es de hoy pero salió PARCIAL: alguna fuente vieja, el buzón sin leer, o no la generó el nocturno.
 *   · ✅ si es de hoy y está completa — y habla igual: si callara en verde, «el nocturno anda» y «el nocturno se
 *     detuvo y nadie lo mira» serían el mismo silencio hasta el segundo día.
 *
 * 🔴 LA FECHA SALE DEL CONTENIDO, NUNCA DEL MTIME: un `git pull` le pone al archivo la hora del pull, y una página de
 *    hace una semana se vería de hoy.
 * 🔴 LEE LO PUBLICADO, NO EL DISCO (como en dependencies-notice): el checkout del arnés puede estar
 *    en otra rama o atrasado. Se lee `origin/main` sin salir a la red; si esta copia no lo tiene, se lee el disco y la
 *    línea LO DICE — «leí lo publicado» y «no pude» no son lo mismo.
 * 🔴 NINGÚN NÚMERO DE LAS FICHAS sale por acá, ni en verde: la línea habla de la página, no la resume.
 *
 * Fail-open total: un error inesperado sale 0 y mudo. Nunca rompe el arranque de una sesión.
 * Apagado: TYCON_DASHBOARD_NOTICE=0 · Para el banco: TYCON_DASHBOARD_REPO (raíz), TYCON_DASHBOARD_NOW (reloj),
 * TYCON_DASHBOARD_GIT (binario de git).
 */
'use strict';
const fs = require('fs');
const path = require('path');

// 🔴 Umbral PROPIO del tablero: el nocturno corre todas las noches, así que dos días es una noche perdida de margen.
//    No es el VEJEZ_MS de dependencias (3 días) ni el del examen de revisores (8): tres preguntas, tres dueños.
const VEJEZ_MS = 2 * 24 * 60 * 60 * 1000;
const FUTURO_TOLERADO_MS = 60 * 60 * 1000;
const CARPETA = 'artifacts';
const ARCHIVO = 'tablero-del-arnes.html';
const DONDE = `${CARPETA}/${ARCHIVO}`;
const PIPELINE = '«tablero-del-arnes» en Azure DevOps';

// Controles C0 y C1, DEL y los separadores de línea U+2028/U+2029 (armados con fromCharCode: escritos literales en el
// fuente cortarían la expresión regular, porque JavaScript los toma como fin de línea).
const NO_IMPRIMIBLES = new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(0x1f) + String.fromCharCode(0x7f) + '-' + String.fromCharCode(0x9f)
  + String.fromCharCode(0x2028) + String.fromCharCode(0x2029) + ']', 'g');
const limpio = (t, max) => String(t).replace(NO_IMPRIMIBLES, ' ').slice(0, max);

/** La línea del aviso para una página ya leída. `nota` es el sufijo cuando se leyó del disco. */
function redactar({ html, ahora, nota = '', sello, copia = null }) {
  const l = sello.leer(html);
  if (!l.sello) {
    // El motivo de un sello roto puede citar un valor de la página: se dice sólo si no trae sello o si está ilegible.
    const cual = l.motivo === 'la página no trae sello' ? 'no trae sello' : 'su sello es ilegible';
    return `🔕 el tablero del arnés publicado no dice de cuándo es (${cual}) — sus números no se muestran · lo genera el pipeline ${PIPELINE}${nota}`;
  }
  const s = l.sello;
  const t = Date.parse(s.generado);
  const fecha = s.generado.slice(0, 10);
  if (t - ahora > FUTURO_TOLERADO_MS) {
    return `🔕 el tablero del arnés publicado dice ser del ${fecha}, posterior a hoy — sus números no se muestran · revisar el pipeline ${PIPELINE}${nota}`;
  }
  if (ahora - t > VEJEZ_MS) {
    // la página venció, pero la copia del clon de operaciones no se trae desde antes: no prueba que no se generó
    const vieja = copia ? copia(t + VEJEZ_MS) : null;
    if (vieja) return `🟠 tablero del arnés: no sé si se generó — su última página es del ${fecha} y ${vieja}${nota}`;
    const dias = Math.floor((ahora - t) / 86400000);
    return `🔕 el tablero del arnés NO SE ESTÁ GENERANDO desde el ${fecha} (hace ${dias} día(s)) — sus números no se muestran a propósito · revisar el pipeline ${PIPELINE}${nota}`;
  }
  const faltas = [];
  if (!sello.isNightly(s.modo) || s.corrida === null) faltas.push('no la generó el nocturno');
  if (s.fuentes.al_dia < s.fuentes.esperadas) faltas.push(`${s.fuentes.al_dia} de ${s.fuentes.esperadas} fuentes al día`);
  if (s.buzon.estado !== 'leido') {
    faltas.push(s.buzon.estado === 'no_leido' ? `las fichas del equipo no se midieron (${limpio(s.buzon.motivo, 160)})` : 'las fichas del equipo no se midieron');
  }
  const cuando = `${fecha} ${s.generado.slice(11, 16)} UTC`;
  return faltas.length
    ? `🟡 tablero del arnés (${cuando}): parcial — ${faltas.join(' · ')} · ${DONDE}${nota}`
    : `✅ tablero del arnés (${cuando}): completo · ${DONDE}${nota}`;
}

function main() {
  const { readEnv } = require('../lib/legacy-names.js');
  const where = 'scripts/hooks/dashboard-notice.js';
  if (readEnv('TYCON_DASHBOARD_NOTICE', { where }) === '0' || process.env.TYCON_EVAL_SANDBOX === '1') return 0;
  const sello = require('../nightly/dashboard/seal.js');  // una copia sin el sello es una copia rota: el wrapper calla
  // de qué árbol se lee: la variable manda; si no, lo decide scripts/lib/night-data.js —en un clon, éste; en una versión
  // bajada, el clon del repo de operaciones que la máquina declara (`paths.operations`, donde se
  // guarda el tablero), o ninguno (y este aviso calla: nunca git sobre ~/.tycon; que el clon falte o no sirva lo dice el aviso
  // de dependencias, una vez por arranque)—. Sin esa biblioteca al lado, se usa tycon-home.js.
  const own = path.resolve(__dirname, '..', '..');
  const homeLib = path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js');
  const nightLib = path.join(__dirname, '..', 'lib', 'night-data.js');
  const N = fs.existsSync(nightLib) ? require(nightLib) : null;
  const porVariable = readEnv('TYCON_DASHBOARD_REPO', { where });
  const noche = porVariable ? { dir: porVariable, source: 'own' }
    : N ? (typeof N.resolveOperations === 'function' ? N.resolveOperations(own) : N.resolve(own))
      : { dir: fs.existsSync(homeLib) ? require(homeLib).maintainedDir(require('os').homedir(), own) : own, source: 'own' };
  const raiz = noche.dir;
  if (!raiz) return 0;
  // la máquina que declara su clon de operaciones mira de cuándo es su copia antes de acusar al nocturno
  const clon = typeof N?.cloneName === 'function' ? N.cloneName(noche.source) : 'el clon de mantenimiento';
  const copia = noche.source === 'operations' || noche.source === 'maintainers' ? (desde) => N.copyAfter(raiz, desde, clon) : null;
  const ahoraFija = readEnv('TYCON_DASHBOARD_NOW', { where });
  const ahora = ahoraFija ? Date.parse(ahoraFija) : Date.now();
  if (Number.isNaN(ahora)) return 0;
  const dir = path.join(raiz, CARPETA);

  // 1 · lo publicado (origin/main, sin red). Se reusa la lectura de dependencies-notice: ya pagó sus defectos.
  let html = null;
  let motivo = null;
  let pub;
  try { pub = require('./dependencies-notice.js').fuentePublicada(raiz, readEnv('TYCON_DASHBOARD_GIT', { where }) || 'git'); }
  catch (e) { pub = { motivo: 'no pude preguntarle a git' }; }
  if (pub.fuente) {
    let nombres = null;
    try { nombres = pub.fuente.listar(dir); } catch (_) { nombres = null; }
    if (nombres && !nombres.includes(ARCHIVO)) {
      // sin página y con la copia del clon de mantenimiento vieja: no se sabe (puede estar publicada y no traída)
      const vieja = copia ? copia(ahora - VEJEZ_MS) : null;
      console.log(vieja ? `🟠 tablero del arnés: no sé si está publicado — ${DONDE} no está en mi copia ${clon.replace(/^el /, 'del ')} y ${vieja}`
        : `🔕 el tablero del arnés no está publicado (${DONDE} no está en main) — lo genera el pipeline ${PIPELINE}`);
      return 0;
    }
    if (nombres) { try { html = pub.fuente.leer(dir, ARCHIVO); } catch (_) { html = null; } }
    if (html === null) motivo = pub.fallo() || 'no pude leer lo publicado';
  } else {
    motivo = pub.motivo;
  }

  // 2 · el disco, DICIÉNDOLO
  let nota = '';
  if (html === null) {
    try { html = fs.readFileSync(path.join(dir, ARCHIVO), 'utf8'); } catch (_) { html = null; }
    if (html === null) {
      console.log(`🔕 el tablero del arnés no está en esta copia (${DONDE}) y no pude leer lo publicado (${limpio(motivo, 120)})`);
      return 0;
    }
    nota = ` · ℹ️ leído del disco, no de lo publicado (${limpio(motivo, 120)})`;
  }
  console.log(redactar({ html, ahora, nota, sello, copia }));
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(); } catch (_) { process.exitCode = 0; }   // fail-open: un aviso roto no traba el arranque
}
module.exports = { redactar, VEJEZ_MS };
