#!/usr/bin/env node
/**
 * large-read-meter.js — hook `Stop`: MIDE cuánto se trajo el agente de un solo archivo en el
 * turno que cierra, y si pudo haberlo leído por rango.
 *
 * Por qué existe: medido en el análisis de tokens, el 88 % del costo de una corrida
 * es el hilo principal releyendo lo acumulado. Con el piso ya recortado, lo que queda
 * arriba es lo que el agente SE TRAE en cada respuesta. Eso no se arregla achicando archivos: se
 * arregla leyendo por rango. Y la lección medida del arnés es que la regla que nada verifica se
 * degrada — los otros dos medidores (estilo de respuesta, pasos largos) ya probaron que la forma
 * funciona. Esto la vuelve un número.
 *
 * Qué NO hace, a propósito: NO bloquea el fin de turno ni deniega una lectura. Mide y cobra al turno
 * siguiente vía `large-read-notice.js` — el mismo criterio que sus dos hermanos.
 *
 * Qué mide (del transcript JSONL del turno que termina), por los DOS canales:
 *   · la tool `Read` SIN `offset`/`limit` → se trajo el archivo entero;
 *   · un comando `Bash` cuyo segmento invoca `cat`/`bat`/`nl` sin tubería, sin redirección de salida,
 *     sin heredoc y sin filtro → se trajo el archivo entero.
 *   Todo lo demás (rango, filtro, búsqueda) cuenta como lectura ACOTADA y no se cobra.
 *
 * El umbral (8.000 caracteres) NO es intuición: sale de barrer 60 transcripts reales (1517 pares de
 * llamada y respuesta). Las lecturas enteras por la herramienta tienen mediana 11.567 y el 57 % pasa
 * los 8.000; las acotadas tienen mediana 747 y sólo el 3 % los pasa. El corte separa las dos
 * poblaciones. `--report` existe para volver a discutirlo con datos, no con impresión.
 *
 * Fail-open total: cualquier error → exit 0 sin output. Nunca rompe el cierre de un turno.
 *
 * Uso manual:
 *   node large-read-meter.js --report        # estadística de cumplimiento
 *   node large-read-meter.js --report --all  # detalle por turno
 *   node large-read-meter.js --selftest      # corre la medición sobre un transcript sintético
 *
 * Opt-out: TYCON_READ_METER=0
 * Umbral:  TYCON_READ_MAX_CHARS (default 8000)
 * Exención puntual: escribir `lectura-entera-ok: <razón>` en el propio comando — queda en el
 * transcript, que es donde tiene que quedar la razón de una excepción.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { readEnv } = require('../lib/legacy-names.js');

const WHERE = 'scripts/hooks/large-read-meter.js';
const STATE_DIR = path.join(os.homedir(), '.claude', 'lectura-grande');
const LOG_PATH = path.join(STATE_DIR, 'log.jsonl');
const PENDING_DIR = path.join(STATE_DIR, 'pending');
const PROBE_PATH = path.join(STATE_DIR, 'input-shape.json');

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG — el umbral y TODAS las excepciones, en un solo lugar (AC 3)
// ─────────────────────────────────────────────────────────────────────────────
const CONFIG = {
  /** Caracteres de un solo archivo a partir de los cuales se cobra. Sale de la medición, no de la intuición. */
  umbral: Number(readEnv('TYCON_READ_MAX_CHARS', { where: WHERE }) || 8000),
  /** Apagado total del medidor y de su aviso. */
  apagado: () => readEnv('TYCON_READ_METER', { where: WHERE }) === '0',
  /** Exención declarada EN el comando: deja la razón escrita donde se lee después. */
  marcaExencion: /lectura-entera-ok\s*:/i,
  /** Comandos que se traen un archivo entero por terminal. */
  lectoresEnteros: /(^|[\s(])(cat|bat|nl)\s/,
  /** Señales de que el segmento acota: rango, filtro, conteo o transformación. */
  acotadores: /(^|[\s(;])(sed\s+-n|head|tail|grep|rg|ag|awk|wc|jq|cut|sort|uniq|diff|python3?|node|perl)(\s|$)/,
};

// ─────────────────────────────────────────────────────────────────────────────
// Clasificación de una lectura
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Saca el archivo de una lectura simple: el primer token que no es el comando ni una opción.
 * Recibe un comando YA validado como inequívoco por `lecturaEnteraBash` — no parsea comillas ni
 * composición, porque para cuando llega acá ya se descartó todo lo que las tenga.
 */
function archivoDe(cmd) {
  const toks = String(cmd).trim().split(/\s+/).filter(Boolean);
  const args = toks.slice(1).filter((x) => !x.startsWith('-'));
  return args.length === 1 ? args[0] : null;
}

/**
 * ¿Este comando de terminal se trajo un archivo entero?
 *
 * 🔴 SÓLO cobra lo INEQUÍVOCO: un `cat`/`bat`/`nl` suelto, con UN argumento, y nada más. Ante la
 * menor complicación —tubería, encadenado, redirección, sustitución, comillas, varias líneas—
 * devuelve null y NO se cobra.
 *
 * Por qué así, y no un parseo más listo: partir el comando en segmentos y buscar patrones tiene
 * defectos de una misma familia, y tres muestran por qué no tiene arreglo por
 * partes:
 *   · `cat > script.sh <<EOF` + una línea `cat /etc/hostname` adentro → cobraría por un archivo que
 *     el comando ESCRIBE, no lee.
 *   · `echo "usa cat aca" x.md` → cobraría, y nombraría un archivo llamado «aca», que no existe.
 *   · `/bin/cat gordo.md` → no cobraría, porque espera la palabra pelada.
 * Entender comandos de terminal es casi un lenguaje entero (comillas, tuberías, redirecciones,
 * textos embebidos) y con búsqueda de patrones se pierde. **Un medidor que acusa en falso pierde
 * toda su autoridad**, así que el error se elige: se prefiere dejar pasar una lectura real antes
 * que inventar una. Los casos que se escapan son comandos compuestos, donde además lo que volvió
 * casi nunca es un archivo entero.
 *
 * Lo que sí cobra, a propósito: la ruta calificada (`/bin/cat`), el bypass de alias (`\cat`), las
 * opciones (`cat -n`), un comentario al final, y `2>/dev/null` o `2>&1` — redirigir el error no
 * cambia lo que volvió por la salida, que es lo que se mide.
 */
function lecturaEnteraBash(cmd) {
  const texto = String(cmd || '');
  if (CONFIG.marcaExencion.test(texto)) return null;   // exención declarada por quien la escribió
  if (texto.includes('\n')) return null;               // varias líneas: un texto embebido o un guion

  let t = texto.split(/\s+#/)[0];                       // el comentario final no es parte del comando
  t = t.replace(/\s2>>?\s*\S+/g, '');                   // el error redirigido no cambia lo que volvió
  if (/[|&;<>`$()'"]/.test(t)) return null;            // cualquier composición: no se cobra

  const toks = t.trim().split(/\s+/).filter(Boolean);
  if (!toks.length) return null;
  const binario = toks[0].replace(/^\\/, '').split('/').pop();   // el BINARIO invocado, no la palabra
  if (!/^(cat|bat|nl)$/.test(binario)) return null;

  return archivoDe(t);
}

/**
 * ¿Este comando fue una lectura ACOTADA? Alimenta el conteo del reporte.
 *
 * 🔴 Sale de `CONFIG` y de ningún otro lado: el umbral y las excepciones viven en UN solo
 * lugar. Una segunda lista acá, más corta, haría desaparecer del reporte sin rastro los turnos cuya
 * única lectura pasa por `wc`, `python3` o `node`.
 *
 * 🔴 Y lleva el MISMO guard de composición que `lecturaEnteraBash`. Sin él, un `cd /repo && cat
 * README.md` —que es una lectura ENTERA que elegimos no cobrar por no arriesgar una acusación
 * falsa— se contaba como «acotada», o sea como cumplimiento. El medidor existe para producir UN
 * número honesto: contar como bien lo que no supimos juzgar lo ensucia en silencio, que es
 * exactamente lo que el AC 4 quiere evitar. Ante la duda, `null`: ni a favor ni en contra.
 */
function esLecturaAcotada(cmd) {
  const texto = String(cmd || '');
  if (texto.includes('<<')) return false;              // texto embebido: escribe, no lee
  const t = ' ' + texto.split(/\s+#/)[0].replace(/\s2>>?\s*\S+/g, '');
  // Una herramienta que acota POR NATURALEZA (rango, filtro, conteo, programa): lo que volvió está
  // acotado por construcción, sin importar cómo esté escrito el resto del comando.
  if (CONFIG.acotadores.test(t)) return true;
  if (!CONFIG.lectoresEnteros.test(t)) return false;
  // Queda un `cat`/`bat`/`nl`. Con tubería, lo que volvió viene filtrado → acotada (decisión D6).
  // Sin tubería es una lectura ENTERA que elegimos no cobrar por no acusar en falso: NO es
  // cumplimiento, y contarla como tal ensuciaría el único número que el medidor produce.
  return t.includes('|');
}


/** ¿La herramienta de lectura del agente se trajo el archivo entero? (sin offset ni limit) */
function lecturaEnteraRead(input) {
  const i = input || {};
  if (i.limit != null) return null;
  // `offset: 0` NO acota: lee desde el principio, igual que no pasar nada. Tratarlo como acotado
  // sería una puerta de escape indistinguible de una lectura entera.
  if (i.offset != null && Number(i.offset) !== 0) return null;
  return i.file_path || i.filePath || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Medición sobre el transcript (molde blocking-meter.js)
// ─────────────────────────────────────────────────────────────────────────────

function parseLines(raw) {
  return String(raw).split(/\r?\n/).filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function blocksOf(rec) {
  const msg = rec.message || rec;
  const c = msg.content;
  return Array.isArray(c) ? c : null;
}

function isGenuineUserPrompt(rec) {
  const msg = rec.message || rec;
  const role = msg.role || rec.role || rec.type;
  if (role !== 'user') return false;
  if (rec.isMeta === true) return false;
  const c = msg.content;
  if (typeof c === 'string') return c.trim().length > 0;
  if (!Array.isArray(c)) return false;
  if (c.some((b) => b && b.type === 'tool_result')) return false;
  return c.some((b) => b && b.type === 'text' && typeof b.text === 'string' && b.text.trim());
}

/** El texto que volvió de una tool, venga como string o como lista de bloques. */
function textoDeResultado(b) {
  let out = b.content;
  if (Array.isArray(out)) out = out.map((x) => (x && typeof x.text === 'string' ? x.text : '')).join('');
  return typeof out === 'string' ? out : null;
}

/**
 * Mide una VENTANA del transcript (los registros desde el Stop anterior — el cursor lo maneja main).
 * Devuelve null si no hay nada medible (ventana sin prompt, o sin ninguna lectura).
 */
function measure(lines) {
  let turnStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isGenuineUserPrompt(lines[i])) { turnStart = i; break; }
  }
  if (turnStart === -1) return null;

  const open = new Map();
  const enteras = [];
  let acotadas = 0;
  let sinClasificar = 0;   // lecturas que no se supo juzgar: no cuentan ni a favor ni en contra

  for (let i = turnStart + 1; i < lines.length; i++) {
    const rec = lines[i];
    const role = (rec.message && rec.message.role) || rec.role || rec.type;
    const blocks = blocksOf(rec);
    if (!blocks) continue;

    if (role === 'assistant') {
      for (const b of blocks) {
        if (!b || b.type !== 'tool_use') continue;
        if (b.name !== 'Bash' && b.name !== 'Read') continue;
        open.set(b.id, { name: b.name, input: b.input || {} });
      }
    } else {
      for (const b of blocks) {
        if (!b || b.type !== 'tool_result' || !open.has(b.tool_use_id)) continue;
        const u = open.get(b.tool_use_id);
        open.delete(b.tool_use_id);
        const texto = textoDeResultado(b);
        if (texto == null) continue;

        const archivo = u.name === 'Read'
          ? lecturaEnteraRead(u.input)
          : lecturaEnteraBash(u.input.command);

        if (archivo) {
          enteras.push({
            archivo,
            chars: texto.length,
            canal: u.name === 'Read' ? 'read' : 'bash',
            // 🔴 NO se guarda el comando: puede traer un token o una credencial tipeada en la
            // línea, y quedaría en texto plano en disco sin barrido.
            // Nadie lo usa: ni el aviso ni el reporte. El archivo y el tamaño
            // alcanzan para explicar el cobro.
          });
        } else if (u.name === 'Read' || esLecturaAcotada(u.input.command)) {
          acotadas++;   // era una lectura, pero acotada: es justo lo que el medidor quiere premiar
        } else if (CONFIG.lectoresEnteros.test(' ' + String(u.input.command || ''))) {
          sinClasificar++;   // parecía una lectura y no se pudo juzgar: se dice, no se maquilla
        }
      }
    }
  }

  if (!enteras.length && !acotadas && !sinClasificar) return null;   // turno sin lecturas
  const peor = enteras.length ? enteras.reduce((a, b) => (b.chars > a.chars ? b : a), enteras[0]) : null;
  return { peor, enteras: enteras.length, acotadas, sinClasificar };
}

function verdict(m) {
  const reasons = [];
  if (m && m.peor && m.peor.chars >= CONFIG.umbral) {
    const canal = m.peor.canal === 'read' ? 'la herramienta de lectura, sin rango' : 'un comando de terminal';
    reasons.push(`se trajo ${fmt(m.peor.chars)} de ${m.peor.archivo} por ${canal} (tope ${fmt(CONFIG.umbral)})`);
  }
  return { over: reasons.length > 0, reasons };
}

function fmt(n) {
  if (n >= 1000) return `${Math.round(n / 1000)} mil caracteres`;
  return `${n} caracteres`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Persistencia / reporte (molde response-style-meter)
// ─────────────────────────────────────────────────────────────────────────────

function ensureDirs() {
  for (const d of [STATE_DIR, PENDING_DIR]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch { /* fail-open */ }
  }
}

function probeOnce(event) {
  if (fs.existsSync(PROBE_PATH)) return;
  try {
    fs.writeFileSync(PROBE_PATH, JSON.stringify({
      recordedAt: new Date().toISOString(),
      topLevelKeys: Object.keys(event).sort(),
    }, null, 2) + '\n');
  } catch { /* fail-open */ }
}

function report(showAll) {
  if (!fs.existsSync(LOG_PATH)) { console.log('Sin mediciones todavía. El hook escribe a', LOG_PATH); return; }
  const rows = parseLines(fs.readFileSync(LOG_PATH, 'utf8'));
  if (!rows.length) { console.log('Log vacío.'); return; }
  const over = rows.filter((r) => r.over);
  const pct = Math.round(((rows.length - over.length) / rows.length) * 100);
  const totalEnteras = rows.reduce((a, r) => a + (r.enteras || 0), 0);
  const totalAcotadas = rows.reduce((a, r) => a + (r.acotadas || 0), 0);
  const totalSinClasificar = rows.reduce((a, r) => a + (r.sinClasificar || 0), 0);
  console.log(`Ventana declarada: umbral ${CONFIG.umbral} caracteres de un solo archivo, por los dos canales (terminal y herramienta de lectura).`);
  console.log(`Turnos medidos (con lecturas): ${rows.length}`);
  console.log(`Cumplieron: ${rows.length - over.length} (${pct}%) · No cumplieron: ${over.length}`);
  console.log(`Lecturas enteras: ${totalEnteras} · acotadas: ${totalAcotadas} · sin clasificar: ${totalSinClasificar}`);
  if (totalSinClasificar) console.log('  («sin clasificar» = parecía una lectura pero el comando era compuesto: no se cobra NI se cuenta como cumplimiento.)');
  const peor = rows.reduce((a, b) => ((b.peorChars || 0) > (a.peorChars || 0) ? b : a), rows[0]);
  if (peor.peorChars) console.log(`La peor: ${peor.peorChars} caracteres de ${peor.peorArchivo} (${peor.peorCanal}) — ${peor.at}`);
  if (showAll) {
    for (const r of rows) {
      console.log(`  ${r.at}  peor=${String(r.peorChars || 0).padStart(7)} (${r.peorArchivo || '—'}, ${r.peorCanal || '—'})  enteras=${r.enteras}  acotadas=${r.acotadas}  s/c=${r.sinClasificar || 0}  ${r.over ? '✗' : '✓'}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Selftest — la medición sobre un transcript sintético (sin harness)
// ─────────────────────────────────────────────────────────────────────────────

function selftest() {
  const rec = (role, content) => JSON.stringify({ type: role, message: { role, content } });
  const uso = (id, name, input) => rec('assistant', [{ type: 'tool_use', id, name, input }]);
  const res = (id, n) => rec('user', [{ type: 'tool_result', tool_use_id: id, content: 'x'.repeat(n) }]);
  const prompt = rec('user', [{ type: 'text', text: 'dale' }]);
  let fallos = 0;
  const check = (nombre, cond) => { if (cond) { console.log(`  ok   — ${nombre}`); } else { console.log(`  MAL  — ${nombre}`); fallos++; } };

  console.log('== lectura-grande-meter --selftest ==');

  // Clasificador de terminal — SÓLO lo inequívoco se cobra
  check('cat entero se cobra', lecturaEnteraBash('cat /a/b.md') === '/a/b.md');
  check('cat -n entero se cobra', lecturaEnteraBash('cat -n /a/b.md') === '/a/b.md');
  check('ruta calificada se cobra', lecturaEnteraBash('/bin/cat /a/b.md') === '/a/b.md');
  check('bypass de alias se cobra', lecturaEnteraBash('\\cat /a/b.md') === '/a/b.md');
  check('error redirigido se cobra', lecturaEnteraBash('cat /a/b.md 2>/dev/null') === '/a/b.md');
  check('comentario al final se cobra', lecturaEnteraBash('cat /a/b.md # ojo con el head') === '/a/b.md');
  check('cat con tubería no', lecturaEnteraBash('cat /a/b.md | grep foo') === null);
  check('cat que escribe no', lecturaEnteraBash("cat > /a/b.md <<'EOF'") === null);
  check('CUERPO de un texto embebido no', lecturaEnteraBash("cat > /s.sh <<EOF\ncat /etc/hostname\nEOF") === null);
  check('la palabra en un argumento no', lecturaEnteraBash('echo "usa cat aca" /a/x.md') === null);
  check('redirección no', lecturaEnteraBash('cat /a/b.md > /tmp/c') === null);
  check('sed por rango no', lecturaEnteraBash("sed -n '1,40p' /a/b.md") === null);
  check('exención declarada no', lecturaEnteraBash('cat /a/b.md # lectura-entera-ok: lo pidió el dev') === null);
  check('compuesto no se cobra (se elige no acusar)', lecturaEnteraBash('date; cat /a/b.md') === null);
  check('dos archivos no se cobra', lecturaEnteraBash('cat /a/b.md /a/c.md') === null);
  check('sólo opciones, sin archivo', lecturaEnteraBash('cat -n') === null);

  // Conteo de lecturas acotadas — sale de CONFIG, no de una lista duplicada
  check('wc cuenta como acotada', esLecturaAcotada('wc -l /a/b.md') === true);
  check('python3 cuenta como acotada', esLecturaAcotada('python3 -c "print(1)"') === true);
  check('un texto embebido no es lectura', esLecturaAcotada("cat > /a/b.md <<'EOF'") === false);
  check('cat con tubería SÍ acota', esLecturaAcotada('cat /a/b.md | grep foo') === true);
  check('cd && cat NO cuenta como acotada', esLecturaAcotada('cd /repo && cat README.md') === false);
  check('dos archivos NO cuenta como acotada', esLecturaAcotada('cat /a/b.md /a/c.md') === false);

  // Clasificador de la herramienta de lectura
  check('Read sin rango se cobra', lecturaEnteraRead({ file_path: '/a/b.md' }) === '/a/b.md');
  check('Read con limit no', lecturaEnteraRead({ file_path: '/a/b.md', limit: 40 }) === null);
  check('Read con offset no', lecturaEnteraRead({ file_path: '/a/b.md', offset: 10 }) === null);
  check('Read con offset 0 SÍ se cobra', lecturaEnteraRead({ file_path: '/a/b.md', offset: 0 }) === '/a/b.md');

  // Medición de un turno completo
  const m = measure(parseLines([prompt, uso('u1', 'Bash', { command: 'cat /a/gordo.md' }), res('u1', 40000)].join('\n')));
  check('mide el turno', m && m.peor && m.peor.chars === 40000 && m.peor.canal === 'bash');
  check('el veredicto cobra', verdict(m).over === true);
  const m2 = measure(parseLines([prompt, uso('u2', 'Read', { file_path: '/a/x.md', limit: 20 }), res('u2', 500)].join('\n')));
  check('una lectura acotada no cobra', m2 && m2.peor === null && verdict(m2).over === false);
  check('turno sin lecturas no se anota', measure(parseLines([prompt].join('\n'))) === null);

  console.log(fallos === 0 ? '\n0 fallos' : `\n${fallos} fallo(s)`);
  process.exit(fallos === 0 ? 0 : 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--selftest')) return selftest();
  if (args.includes('--report')) return report(args.includes('--all'));
  if (CONFIG.apagado()) return;

  let event = {};
  try {
    const stdin = fs.readFileSync(0, 'utf8');
    event = stdin ? JSON.parse(stdin) : {};
  } catch { return; }
  if (event.stop_hook_active === true) return;

  const tPath = event.transcript_path || event.transcriptPath;
  if (!tPath || !fs.existsSync(tPath)) return;
  let lines;
  try { lines = parseLines(fs.readFileSync(tPath, 'utf8')); } catch { return; }

  ensureDirs();
  probeOnce(event);

  // Cursor por sesión: la ventana entre dos Stops ES el turno (misma razón que blocking-meter).
  const sessionId = event.session_id || event.sessionId || '_nosession';
  const cursorPath = path.join(STATE_DIR, `cursor-${sessionId}.json`);
  let cursor = 0;
  try { cursor = JSON.parse(fs.readFileSync(cursorPath, 'utf8')).lines || 0; } catch { cursor = 0; }
  if (cursor > lines.length) cursor = 0;   // transcript nuevo/rotado → ventana completa
  const ventana = lines.slice(cursor);

  // 🔴 El cursor se graba DESPUÉS de medir. Al revés, si `measure` explota el catch de borde se la
  // traga y el cursor YA avanzó: esa ventana de lecturas se pierde para siempre, sin log y sin
  // pendiente. Es la única defensa que faltaba y es gratis.
  const m = measure(ventana);
  try { fs.writeFileSync(cursorPath, JSON.stringify({ lines: lines.length }) + '\n'); } catch { /* fail-open */ }
  if (!m) return;                          // turno sin lecturas → nada que anotar
  const v = verdict(m);
  const at = new Date().toISOString();

  if (v.over) {
    try {
      fs.writeFileSync(path.join(PENDING_DIR, `${sessionId}.json`), JSON.stringify({
        at, sessionId, peor: m.peor, enteras: m.enteras, acotadas: m.acotadas,
        sinClasificar: m.sinClasificar,
        umbral: CONFIG.umbral, reasons: v.reasons,
      }, null, 2) + '\n');
    } catch { /* fail-open */ }
  }

  try {
    fs.appendFileSync(LOG_PATH, JSON.stringify({
      at, sessionId, cwd: event.cwd || process.cwd(),
      peorChars: m.peor ? m.peor.chars : 0,
      peorArchivo: m.peor ? m.peor.archivo : null,
      peorCanal: m.peor ? m.peor.canal : null,
      enteras: m.enteras, acotadas: m.acotadas, sinClasificar: m.sinClasificar,
      umbral: CONFIG.umbral, over: v.over, reasons: v.reasons,
    }) + '\n');
  } catch { /* fail-open */ }
}

// 🔴 El guard: sin él, `main()` correría al REQUERIR el archivo — se quedaría esperando stdin, o
// mataría con `process.exit(0)` al proceso que lo requería. O sea, los exports de abajo serían
// inalcanzables. Es el mismo guard que
// usan los otros hooks de esta carpeta que exportan funciones.
if (require.main === module) {
  try { main(); } catch { /* fail-open: jamás romper el cierre del turno */ }
  if (!process.argv.slice(2).includes('--selftest')) process.exit(0);
}

module.exports = { CONFIG, archivoDe, esLecturaAcotada, lecturaEnteraBash, lecturaEnteraRead, measure, verdict };
