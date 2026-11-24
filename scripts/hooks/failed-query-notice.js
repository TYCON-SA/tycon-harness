#!/usr/bin/env node
/**
 * failed-query-notice.js — «no lo veo» no es «no hay»: una consulta a un servicio que devolvió
 * VACÍO con el código de salida ENMASCARADO no se puede leer como «no hay nada».
 *
 * ── POR QUÉ EXISTE ───────────────────────────────────────────────────────────────────────────
 * Una consulta puede FALLAR (el proyecto no se llama `Acme`, se llama `Acme Logistica`) y su error se lo come el `| sed`
 * del final: la salida queda vacía — idéntica a «no hay ninguno». Sobre esa premisa se afirma
 * «ese repo no tiene pull request abierto» y se da por cerrado un trabajo con un PR abierto sin ver.
 * Es el mismo defecto que un `ls` a la carpeta equivocada leído como
 * «no hay documentación», una capa más arriba: allá el silenciador es un `| head`, acá un `| sed`.
 *
 * ── QUÉ HACE ─────────────────────────────────────────────────────────────────────────────────────
 * PostToolUse de Bash y de PowerShell (la herramienta de Claude Code en Windows). Dos miradas, las dos por stderr + exit 2 (el canal que llega al modelo):
 *
 *  1. «Consulta vacía con el código de salida enmascarado». Corta el comando en SEGMENTOS (por salto
 *     de línea, `;`, `&&`, `||`, `|`, paréntesis, `$(`, backticks; fuera de comillas; sin los cuerpos
 *     de heredoc) y mira cada segmento que sea una CONSULTA —un listado de la plataforma (lo dice su conector),
 *     `curl` sin método de escritura, `npm view`, `git ls-remote`— cuya salida va a la pantalla (no
 *     a un archivo, no a /dev/null). Avisa cuando la salida atribuible a esa consulta quedó vacía Y
 *     el código de salida no se podía ver: un filtro detrás del pipe sin `pipefail`, un `|| true`,
 *     un `$(…)`, o un comando más después (`; echo listo`). 🔴 `2>/dev/null` SOLO no cuenta: si el
 *     comando falla, el modelo ve «Exit code N» igual (el harness lo devuelve así); sólo pierde el
 *     mensaje. Y si la respuesta ya dice que falló, el hook calla — el modelo lo está viendo.
 *     La salida se ATRIBUYE: las líneas que imprimió un `echo`/`printf` del mismo comando (los
 *     encabezados «== SR ==» de ejemplo) se descuentan antes de decidir si quedó vacío.
 *  2. Lo propio de cada plataforma, como «ese proyecto no existe en la organización». Lo dice su conector.
 *
 * LO DE CADA PLATAFORMA lo trae su conector, en `integrations/<conector>/scripts/query-notice.js` del mismo árbol:
 * `programas` (los comandos suyos), `clasificar({ pos, limpio })` → 'consulta' u 'otro', y si tiene, `avisos(cmd,
 * ayuda)` y `refrescar(org, ayuda)` (lo que corre `--refresh`; el instalador lo lanza cada 7 días). Este gancho no
 * nombra ninguna plataforma. Suelto, sin la carpeta de conectores al lado, mira sólo lo neutro.
 *
 * En PowerShell: `Invoke-RestMethod`/`irm`/`Invoke-WebRequest`/`iwr` sin método
 * de escritura son consultas; tapan el fallo un `-ErrorAction SilentlyContinue` (o `-EA 0`, `Ignore`), un
 * `try { … } catch { }` y una tubería a un cmdlet (`Select-String`, `Where-Object`, `ForEach-Object`…). El consejo
 * del aviso nombra `$LASTEXITCODE` en vez de `rc=$?`. `2>$null` solo no cuenta, por lo mismo que `2>/dev/null`.
 *
 * Lo que NO hace, a propósito: no mira la salida de escrituras (crear un pedido, `curl -X POST`),
 * descargas (`curl -o`, `wget`) ni salidas redirigidas a archivo — ahí el vacío es
 * lo esperado; no habla en comandos de segundo plano (su stdout llega vacío por diseño); y no
 * decide nada: dice «no sé si no hay o si falló» y deja el `rc=$?` en manos del que consulta.
 *
 * Medido con `--measure` sobre las transcripciones reales (lee `toolUseResult`, que es lo que el
 * hook ve, no el texto renderizado): ver el número en `install-tycon-hooks.sh`, al registrar el hook.
 * Off: TYCON_FAILED_QUERY_NOTICE=0. Red: controls-bench/cases/hooks/39-consulta-fallida-notice.json.
 *
 * 🔴 Lo que el hook cuida, cada uno con su caso en el banco: la mirada del proyecto lee SÓLO el `-p` de un comando
 * de la plataforma de verdad (no imprime una contraseña de un `login -p`, no marca `mkdir -p`, ni vuelca los proyectos
 * al contexto desde una tabla markdown dentro de un heredoc); la primera ve la
 * consulta aunque no arranque el comando (segunda línea, `cd … &&`, `for … do`), no llama consulta a
 * escrituras y descargas, calla en segundo plano y dispara aunque un `echo` de cabecera
 * imprima algo.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// La carpeta del estado la sabe scripts/setup/harness/tycon-home.js. Se carga SI ESTÁ, por su ruta: este
// archivo viaja suelto (al banco, a laboratorios de pruebas); ahí vale la ruta de siempre, que es la misma (T5 de
// scripts/tests/tycon-home.test.js). Si está y no carga, tira.
const stateDirOf = (() => { const lib = path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js'); return require('fs').existsSync(lib) ? require(lib).stateDir : (h) => path.join(h || require('os').homedir(), '.claude', '.tycon-pipeline'); })();

// ── 1. cortar el comando en segmentos ─────────────────────────────────────────────────────────
// La definición es una sola y la comparten este hook, el freno de
// sesiones y el freno de producción: ver scripts/lib/shell-parse.js.
const { segmentos, tokens, PREFIJOS } = require(require('path').join(__dirname, '..', 'lib', 'shell-parse.js'));
// lo que el gancho le pasa a cada conector: el mismo cortador y la carpeta del estado
const AYUDA = Object.freeze({ segmentos, tokens, PREFIJOS, stateDir: stateDirOf });

// Lo de cada plataforma, de su conector (ver la cabecera). Uno que está y no carga se saltea: el gancho no frena nada.
const CONECTORES = (() => {
  const dir = path.join(__dirname, '..', '..', 'integrations');
  let nombres = [];
  try { nombres = fs.readdirSync(dir).sort(); } catch { return []; }
  const out = [];
  for (const n of nombres) {
    const f = path.join(dir, n, 'scripts', 'query-notice.js');
    if (!fs.existsSync(f)) continue;
    try {
      const m = require(f);
      if (Array.isArray(m.programas) && typeof m.clasificar === 'function') out.push(m);
    } catch { /* un conector roto no tumba el aviso */ }
  }
  return out;
})();
const FILTROS = /^(?:sed|grep|egrep|fgrep|head|tail|jq|python3?|awk|cut|tr|sort|uniq|wc|xargs|column|tee|less|cat|yq|fold|nl|paste)\b/;
// Los filtros de PowerShell: en la herramienta PowerShell de Windows la tubería típica no pasa por sed
// sino por un cmdlet. No hay pipefail que valga ahí: lo que se ve al final es lo del último de la cadena.
const FILTROS_PS = /^(?:Select-String|sls|Select-Object|select|Where-Object|where|\?|ForEach-Object|foreach|%|Sort-Object|Format-Table|ft|Format-List|fl|Out-String|ConvertFrom-Json|ConvertTo-Json|Measure-Object|measure|Group-Object|findstr)(?=\s|$)/i;
// La consulta de PowerShell que no escribe: Invoke-RestMethod / Invoke-WebRequest y sus alias
const PS_WEB = new Set(['invoke-restmethod', 'irm', 'invoke-webrequest', 'iwr']);
const PS_WEB_ESCRIBE = /(?:^|\s)-Method\s+['"]?(?:POST|PUT|PATCH|DELETE)\b|(?:^|\s)-(?:Body|InFile|OutFile|Form)\b/i;
// `-ErrorAction SilentlyContinue` (o `-EA 0`, `Ignore`): el error no se muestra y la herramienta no lo cuenta como fallo
const PS_CALLA_ERROR = /(?:^|\s)-(?:ErrorAction|EA)\s*:?\s*['"]?(?:SilentlyContinue|Ignore|0)\b/i;
// `try { <consulta> } catch { … }`: el catch se come el error. El cortador no parte llaves; se mira acá.
const PS_TRY = /^\s*try\s*\{([\s\S]*?)\}\s*catch\b/i;

/** clasifica un segmento: {clase:'consulta'|'echo'|'otro', cmd, argv} */
function clasificar(texto) {
  const limpio = texto.replace(PREFIJOS, '');
  const argv = tokens(limpio);
  if (!argv.length) return { clase: 'otro', cmd: '', argv };
  // en Windows llega `<programa>.cmd` o `C:\\…\\<programa>.exe`, y PowerShell no distingue mayúsculas
  const cmd = path.basename(argv[0].replace(/\\/g, '/')).replace(/\.(?:exe|cmd|bat)$/i, '');
  const cmdL = cmd.toLowerCase();
  if (cmd === 'echo' || cmd === 'printf') return { clase: 'echo', cmd, argv };
  if (cmdL === 'write-host' || cmdL === 'write-output') return { clase: 'echo', cmd: 'echo', argv };
  // la salida va a un archivo (o a la nada): el vacío en pantalla es lo esperado
  // sólo la salida ESTÁNDAR: `2>/dev/null` es stderr y no cambia lo que se ve en pantalla
  if (/(?:^|[^\d&>])(?:1?>>?|&>)\s*(?!&)\S/.test(limpio)) return { clase: 'otro', cmd, argv };
  const pos = []; for (let i = 1; i < argv.length && !argv[i].startsWith('-'); i++) pos.push(argv[i]);
  const conector = CONECTORES.find((c) => c.programas.includes(cmd));
  if (conector) return { clase: conector.clasificar({ pos, limpio }) === 'consulta' ? 'consulta' : 'otro', cmd, argv };
  if (cmd === 'curl') {
    const escribe = /(?:^|\s)(?:-X|--request)\s+(?:POST|PUT|PATCH|DELETE)\b|(?:^|\s)(?:-d|--data(?:-\w+)?|-F|--form|-T|--upload-file)\b|(?:^|\s)-O\b|(?:^|\s)(?:-o|--output)\s+(?!-\s|-$)\S/.test(limpio);
    return { clase: escribe ? 'otro' : 'consulta', cmd, argv };
  }
  if (PS_WEB.has(cmdL)) return { clase: PS_WEB_ESCRIBE.test(limpio) ? 'otro' : 'consulta', cmd, argv };
  if (cmd === 'wget') return { clase: /(?:^|\s)(?:-qO-|-O\s*-|--output-document=-)/.test(limpio) ? 'consulta' : 'otro', cmd, argv };
  if (cmd === 'npm' && ['view', 'info', 'search', 'outdated', 'ls', 'list', 'audit'].includes(pos[0])) return { clase: 'consulta', cmd, argv };
  if (cmd === 'git' && pos[0] === 'ls-remote') return { clase: 'consulta', cmd, argv };
  return { clase: 'otro', cmd, argv };
}

const PIPEFAIL = /set\s+-o\s+pipefail|set\s+-[A-Za-z]*o\s+pipefail|PIPESTATUS/;

/**
 * Consultas cuyo código de salida el modelo NO puede ver.
 * @returns {{texto:string, como:string}[]}
 */
function consultasEnmascaradas(cmd) {
  const segs = segmentos(cmd);
  const pipefail = PIPEFAIL.test(cmd);
  const out = [];
  segs.forEach((seg, i) => {
    const enTry = PS_TRY.exec(seg.texto);
    if (enTry) {
      if (segmentos(enTry[1]).some((s) => clasificar(s.texto).clase === 'consulta')) out.push({ texto: enTry[1].trim(), como: 'el try/catch se come el error' });
      return;
    }
    const c = clasificar(seg.texto);
    if (c.clase !== 'consulta') return;
    // `… | head -3 &`: la cadena entera va al fondo; su salida no está en este resultado
    let fin = i; while (segs[fin] && segs[fin].sep === '|') fin++;
    if (segs[fin] && segs[fin].sep === '&') return;
    const sig = segs[i + 1];
    const anterior = segs[i - 1];
    let como = null;
    if (PS_CALLA_ERROR.test(seg.texto)) como = '-ErrorAction le saca el error de la vista';
    else if (seg.sep === '|' && sig && FILTROS_PS.test(sig.texto.trim())) como = `filtrado por ${sig.texto.trim().split(/\s+/)[0]}: lo que se ve es lo del último de la tubería`;
    else if (seg.sep === '|' && sig && FILTROS.test(sig.texto.replace(PREFIJOS, '')) && !pipefail) como = 'filtrado sin pipefail';
    else if (seg.sep === '||') como = `«|| ${(sig && sig.texto.split(/\s+/)[0]) || '…'}» se traga el fallo`;
    else if (anterior && anterior.sep === '$(') como = 'dentro de un $(…)';
    else if (seg.sep === ';' && sig) como = 'hay otro comando después: el código de salida que se ve es el del último';
    if (como) out.push({ texto: seg.texto, como });
  });
  return out;
}

/** líneas de stdout que NO son de la consulta: lo que imprimieron los echo/printf del mismo comando */
function salidaAtribuida(cmd, stdout) {
  const lineas = String(stdout == null ? '' : stdout).split('\n');
  const literales = new Set();
  const segs = segmentos(cmd);
  // Las variables que se LLENARON con una consulta (`R=$(curl …)`): lo que traen ES la salida de la
  // consulta. Cualquier otra variable en un echo (la del `for`, un contador) es texto de cabecera.
  const deConsulta = new Set();
  segs.forEach((seg, i) => {
    const m = seg.sep === '$(' && segs[i + 1] && /(?:^|[\s;])([A-Za-z_][A-Za-z0-9_]*)=$/.exec(seg.texto);
    if (m && clasificar(segs[i + 1].texto).clase === 'consulta') deConsulta.add(m[1]);
  });
  for (const seg of segs) {
    const c = clasificar(seg.texto);
    if (c.clase !== 'echo') continue;
    const args = c.argv.slice(1).filter((a) => !/^-[neE]+$/.test(a));
    const lit = (c.cmd === 'printf' ? (args[0] || '') : args.join(' ')).replace(/\\n/g, '\n');
    for (const l of lit.split('\n')) {
      if (!l.trim()) continue;
      // Una variable se captura: la línea es «del echo» sólo si la variable NO trajo nada. «tok=$TOK» con
      // «tok=» en pantalla → texto del echo (la consulta devolvió vacío); «resultado: $R» con
      // «resultado: succeeded» → ESO es la salida de la consulta, y no se descuenta.
      // el espacio pegado a una variable es opcional: «etiqueta: $R» con R vacío imprime «etiqueta:» (el trim se lo come)
      const re = '^' + l.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\\\$(?:\\\{)?(\w+)(?:[^}]*\\\})?/g, (_, nombre) => (deConsulta.has(nombre) ? '(.*)' : '(?:.*)'))
        .replace(/ (\((?:\?:)?\.\*\))/g, ' ?$1').replace(/(\((?:\?:)?\.\*\)) /g, '$1 ?') + '$';
      literales.add(re);
    }
  }
  const patrones = [...literales].map((r) => new RegExp(r));
  const delEcho = (l) => patrones.some((re) => { const m = re.exec(l); return m && m.slice(1).every((g) => !g || !g.trim()); });
  return lineas.filter((l) => l.trim() && !delEcho(l.trim())).join('\n');
}

// ── los avisos ────────────────────────────────────────────────────────────────────────────────
function avisos(cmd, stdout, stderr, opciones = {}) {
  const out = [];
  const enm = consultasEnmascaradas(cmd);
  if (enm.length && stdout != null && !String(stderr == null ? '' : stderr).trim() && salidaAtribuida(cmd, stdout).trim() === '') {
    const c = enm[0];
    const comoMirar = opciones.tool === 'PowerShell'
      ? '   código de salida (`$LASTEXITCODE` o `$?` justo después de la consulta, sin -ErrorAction ni try/catch) o repetila sin filtrar.\n'
      : '   código de salida (`rc=$?` antes de cualquier pipe, o `set -o pipefail`) o repetila sin filtrar.\n';
    out.push(
      `⚠️  Esa consulta devolvió VACÍO y el código de salida no se podía ver (${c.como}):\n` +
      `   «${c.texto.replace(/\s+/g, ' ').slice(0, 100)}»\n` +
      '   no sé si «no hay nada» o si el comando FALLÓ — y se ven igual. Antes de concluir, mirá el\n' +
      comoMirar +
      '   Pasó dos veces: «no hay PR abierto» con una consulta que había fallado.\n',
    );
  }
  // lo propio de cada plataforma (el proyecto que no existe, por ejemplo), de su conector
  for (const c of CONECTORES) if (typeof c.avisos === 'function') out.push(...c.avisos(cmd, AYUDA));
  return out;
}

module.exports = { avisos, segmentos, clasificar, consultasEnmascaradas, salidaAtribuida, tokens };

// ── medición sobre transcripciones reales (lo que el hook VE: toolUseResult) ─────────────────
function medir(archivos) {
  let tot = 0, consultas = 0, hablaria = 0, fondo = 0, fallidos = 0;
  const ej = [];
  for (const f of archivos) {
    const usos = new Map();
    let lineas = [];
    try { lineas = fs.readFileSync(f, 'utf8').split('\n'); } catch { continue; }
    for (const line of lineas) {
      let d; try { d = JSON.parse(line); } catch { continue; }
      const c = d && d.message && d.message.content;
      if (Array.isArray(c)) {
        for (const it of c) {
          if (it.type === 'tool_use' && (it.name === 'Bash' || it.name === 'PowerShell') && it.input && it.input.command) usos.set(it.id, { ...it.input, tool: it.name });
        }
      }
      const r = d && d.toolUseResult;
      if (r === undefined || !Array.isArray(c)) continue;
      const res = c.find((it) => it.type === 'tool_result' && usos.has(it.tool_use_id));
      if (!res) continue;
      const input = usos.get(res.tool_use_id);
      tot++;
      if (input.run_in_background || (r && typeof r === 'object' && r.backgroundTaskId)) { fondo++; continue; }
      if (typeof r === 'string') { fallidos++; continue; }            // «Error: Exit code N»: el modelo lo vio
      const cmd = input.command;
      if (consultasEnmascaradas(cmd).length || CONECTORES.some((c) => typeof c.proyectos === 'function' && c.proyectos(cmd, AYUDA).length)) consultas++;
      const av = avisos(cmd, r.stdout == null ? '' : r.stdout, r.stderr, { tool: input.tool });
      if (av.length) { hablaria++; if (ej.length < 8) ej.push(cmd.replace(/\s+/g, ' ').slice(0, 110)); }
    }
  }
  console.log(`comandos Bash con resultado: ${tot} · en segundo plano (no se juzgan): ${fondo} · fallidos a la vista (no se juzgan): ${fallidos}`);
  console.log(`consultas enmascaradas o con --project: ${consultas} · el aviso habría hablado: ${hablaria}  (${(hablaria * 100 / Math.max(tot, 1)).toFixed(2)}% de los comandos)`);
  ej.forEach((e) => console.log('   ej:', e));
}

/** `--refresh`: lo corre cada conector que sabe refrescar lo suyo (la lista de proyectos, por ejemplo). */
function refrescar(org) {
  const con = CONECTORES.filter((c) => typeof c.refrescar === 'function');
  if (!con.length) { console.error('consulta-fallida-notice: ningún conector tiene algo que refrescar'); return 2; }
  return Math.max(...con.map((c) => c.refrescar(org, AYUDA)));
}

if (require.main === module) {
  // Los nombres viejos siguen andando. Sólo a mano: como hook corre sin argumentos, y ahí ni se mira.
  if (process.argv.length > 2) require('../lib/legacy-names.js').aliasArgv('scripts/hooks/failed-query-notice.js', { exitCode: 2, prefix: 'consulta-fallida-notice: ' });
  const args = process.argv.slice(2);
  if (args[0] === '--measure') { medir(args.slice(1)); process.exit(0); }
  if (args[0] === '--refresh') { const i = args.indexOf('--org'); process.exit(refrescar(i >= 0 ? args[i + 1] : null)); }
  const { readEnv } = require('../lib/legacy-names.js');
  if (readEnv('TYCON_FAILED_QUERY_NOTICE', { where: 'scripts/hooks/failed-query-notice.js' }) === '0') process.exit(0);
  let payload = '';
  try { payload = fs.readFileSync(0, 'utf8'); } catch { process.exit(0); }
  try {
    const d = JSON.parse(payload || '{}');
    // Bash o la herramienta PowerShell de Claude Code en Windows (misma entrada)
    if (d.tool_name && !['Bash', 'PowerShell'].includes(d.tool_name)) process.exit(0);
    const ti = d.tool_input || {};
    const cmd = String(ti.command || '');
    if (!cmd || ti.run_in_background === true) process.exit(0);
    const r = d.tool_response;
    if (r && typeof r === 'object' && (r.backgroundTaskId || r.interrupted)) process.exit(0);
    if (typeof r === 'string' && /^\s*Error: Exit code \d+/.test(r)) process.exit(0);   // el fallo está a la vista
    const stdout = r == null ? null : (typeof r === 'string' ? r : (r.stdout != null ? r.stdout : (r.output != null ? r.output : null)));
    if (stdout != null && /^\s*Error: Exit code \d+/.test(String(stdout))) process.exit(0);
    const stderr = r && typeof r === 'object' && typeof r.stderr === 'string' ? r.stderr : '';
    const out = avisos(cmd, stdout, stderr, { tool: d.tool_name });
    if (out.length) { process.stderr.write(out.join('')); process.exit(2); }
  } catch { /* fail-open */ }
  process.exit(0);
}
