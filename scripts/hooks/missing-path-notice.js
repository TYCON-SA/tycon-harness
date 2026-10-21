#!/usr/bin/env node
/**
 * missing-path-notice.js — PostToolUse (Bash|PowerShell): avisa cuando un comando de LECTURA nombró una ruta
 * que NO existe.
 *
 * Caso que cubre: `ls -R proyecto/specs proyecto/docs 2>/dev/null | head -60` devuelve VACÍO cuando el shell está
 * parado en otra carpeta. Si el agente lee ese vacío como "no hay documentación", diseña sobre una premisa falsa
 * y nadie se entera hasta varios turnos después.
 *
 * 🔴 Por qué NO es un control sobre "salida vacía". Un vacío es la respuesta CORRECTA en montones de
 * casos (el grep que confirma que algo no está), así que avisar por vacío sería ruido puro y se
 * terminaría apagando. Lo que distingue el error del caso legítimo no es la salida: es que la ruta
 * NO EXISTE. Eso se resuelve con un stat y no tiene ambigüedad.
 *
 * 🔴 Por qué mira sólo comandos de LECTURA. Nombrar una ruta inexistente es NORMAL —y correcto— al
 * crear (`mkdir -p`, `touch`, `> salida.txt`), al buscar (`find`, globs) y al chequear ausencia
 * a propósito (`test -f x || …`). Sin esa distinción el aviso saldría en ~1 de cada 9 comandos
 * (medido) y sería inservible. Con ella, sólo habla cuando alguien quiso LEER algo que no está.
 *
 * Los tres silenciadores del caso, para que quede escrito: `2>/dev/null` mató el stderr; el
 * `| head` hizo que el pipeline saliera 0 (o sea que un control basado en "falló el comando"
 * TAMPOCO lo habría atrapado); y el stdout vacío es idéntico al de una carpeta vacía de verdad.
 * Este control no depende de ninguna de esas tres señales: mira el disco.
 *
 * Portable a propósito: los dos eslabones que cubre (silenciar el error, leer el vacío como
 * inexistencia) pasan igual en Claude Code y en Codex. El TERCER eslabón —el `cd` que queda
 * pegado entre llamadas— es exclusivo de Claude Code y se cierra aparte, con la variable canónica
 * CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR (Codex ya arranca cada comando en la raíz).
 *
 * Nunca bloquea: exit 0 siempre. Off: TYCON_MISSING_PATH_NOTICE=0
 * Modo medición (no es un hook): `node missing-path-notice.js --measure <archivo.jsonl>…`
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// Comandos cuya presencia hace que los argumentos-ruta sean intención de LEER.
const READ_CMDS = /^(ls|cat|head|tail|wc|less|more|stat|file|diff|source|nl|md5|md5sum|shasum|column|jq|yq)$/;
// Todo lo que hace que una ruta ausente sea legítima: crear, buscar, chequear, mover.
const WRITE_OR_PROBE = /\b(mkdir|touch|cp|mv|rm|tee|find|test|install|ln|mktemp|rsync|scp|git|npm|npx|yarn|pnpm|docker|curl|wget|chmod|chown|dd|truncate)\b|\[\s|\[\[|>>?/;
// 🔴 La redirección de stderr se SACA del segmento ANTES de buscar señales de escritura. Si `2>` contara
// entre los indicadores de "acá se crea algo", se descartaría el comando que este control existe para
// atrapar: `2>/dev/null` es exactamente la señal que hay que cazar, no una razón para mirar a otro lado.
const STDERR_REDIR = /\s*\d?(?:2>&1|2>\s*\/dev\/null|2>\s*&\s*1|&>\s*\/dev\/null)\s*/g;

function looksLikePath(tok) {
  if (!tok || tok.startsWith('-')) return false;
  if (tok.startsWith('.') && !tok.includes('/')) return false; // filtro jq/yq (".name"), no una ruta (FP-2)
  if (/[*?\[\]{}$`~!]/.test(tok)) return false;        // glob, variable, sustitución, ~ → indecidible
  if (/^\d+$/.test(tok)) return false;
  return tok.includes('/') || /\.[A-Za-z0-9]{1,6}$/.test(tok);
}

/**
 * Rutas de LECTURA nombradas por el comando. PURA — no toca disco.
 * @returns {string[]}
 */
function readPaths(cmd) {
  const out = [];
  // La continuación de línea (`\` al final) NO separa comandos: `rm -rf \<nl> "/x"` es UN comando.
  // Partirlo dejaría la ruta huérfana de su `rm` y el control opinaría sobre un borrado.
  // FP-3: los CUERPOS de heredoc no son comandos — un `cat config/x.json` DENTRO de un script que
  // se está escribiendo no es una lectura de este shell. Se recortan (queda la línea de apertura).
  let texto = String(cmd || '').replace(/(<<-?[ \t]*(['"]?)([A-Za-z_][\w]*)\2[^\n]*\n)[\s\S]*?\n[ \t]*\3[ \t]*(?=\n|$)/g, '$1');
  texto = texto.replace(/\\\n/g, ' ');
  // 🔴 Ante escapes de shell que no sabemos tokenizar bien (`\ ` en un nombre con espacios, comillas
  // anidadas), el control se CALLA. Medido: los restos del ruido histórico eran todos de acá
  // (`ls -d /Applications/Google\ Chrome.app` se partía en dos rutas falsas). Un control que ante
  // la duda habla es un control que se apaga; ante la duda se calla y pierde ese caso.
  if (/\\[ \t"']/.test(texto)) return [];
  // El lado derecho de `||` es un PLAN B: se ejecuta justo cuando lo de la izquierda falló, así que
  // una ruta ausente ahí es lo esperado, no un error (`which x || ls /otro/lugar/x`). Se corta ahí.
  const sinFallback = texto.split(/\|\|/)[0];
  for (const seg of sinFallback.split(/\s*(?:&&|;|\||\n)\s*/)) {
    const s = seg.trim().replace(STDERR_REDIR, ' ');
    if (!s || WRITE_OR_PROBE.test(s)) continue;        // el segmento crea/busca/chequea → no opina
    const toks = s.match(/(?:'[^']*'|"[^"]*"|[^\s]+)/g) || [];
    if (!toks.length) continue;
    const bin = path.basename(toks[0].replace(/^['"]|['"]$/g, ''));
    if (!READ_CMDS.test(bin)) continue;
    const delSeg = [];
    for (const raw of toks.slice(1)) {
      const t = raw.replace(/^['"]|['"]$/g, '');
      if (looksLikePath(t)) delSeg.push(t);
    }
    // Varias rutas en UN comando de lectura es un sondeo (`ls /opt/bin/x /usr/bin/x`): que falte
    // alguna es normal. Sólo interesa cuando NINGUNA está — que es el caso del incidente, donde
    // las dos rutas pedidas faltaban. Lo marca el consumidor; acá se devuelven agrupadas.
    if (delSeg.length) out.push(delSeg);
  }
  // FP-4 (TOCTOU): este hook corre DESPUÉS del comando. `cat log.txt && rm log.txt` deja la ruta
  // ausente en el disco con una lectura que fue perfectamente válida. Si el comando entero también
  // la borra/mueve, no se opina sobre ella.
  if (/\b(rm|mv|rmdir|unlink)\b/.test(String(cmd || ''))) return [];
  return out;
}

/**
 * Rutas que NO existen, resueltas contra `cwd`. Sólo se opina si el PADRE existe: si el padre
 * tampoco está, puede ser un repo que se movió y el juicio no es fiable (limitación real, medida:
 * en el corpus histórico ~13% de las rutas ya no existen por mudanzas, no por errores).
 */
function missing(grupos, cwd, conservador) {
  const out = [];
  for (const grupo of grupos) {
    const faltan = [];
    for (const p of grupo) {
      const abs = path.isAbsolute(p) ? p : path.join(cwd, p);
      try {
        if (fs.existsSync(abs)) { faltan.length = 0; break; }   // una existe → era un sondeo
        // 🔴 `conservador` SÓLO para medir sobre el corpus histórico, donde un padre ausente suele
        // ser un repo que se mudó y no un error. En PRODUCCIÓN va apagado a propósito: la primera
        // versión lo aplicaba siempre y con eso se tapaba el incidente que motiva el control
        // (el `ls` apuntaba a `TIMBOProyecto/specs` desde una carpeta donde `TIMBOProyecto` TAMPOCO
        // existía, así que el padre ausente silenciaba el aviso). Lo cazó el caso del banco.
        if (conservador && !fs.existsSync(path.dirname(abs))) { faltan.length = 0; break; }
        faltan.push(p);
      } catch { faltan.length = 0; break; }
    }
    out.push(...faltan);
  }
  return out;
}

module.exports = { readPaths, missing };

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === '--measure') {
    let tot = 0, hablaria = 0, truncados = 0, indecidibles = 0, sin_absolutas = 0;
    const ej = [];
    for (const f of args.slice(1)) {
      for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
        let d; try { d = JSON.parse(line); } catch { continue; }
        if (d.tool !== 'Bash') continue;
        const cmd = d.summary || '';
        if (!cmd) continue;
        tot++;
        if (cmd.length === 500) { truncados++; continue; }   // cortado por el grabador → no se cuenta
        // No se puede juzgar un comando con `cd` propio (no sabemos contra qué resolvió) ni rutas
        // en /tmp (efímeras por diseño: que hoy no estén no dice NADA del comando de entonces).
        // Descartarlas no es maquillar el número: es no contar lo que la medición no puede saber.
        if (/\bcd\s/.test(cmd)) { indecidibles++; continue; }
        // 🔴 Sólo se miden rutas ABSOLUTAS. Una relativa se resuelve contra el directorio donde
        // corrió el comando, y el grabador NO lo guarda — medirlas contra $HOME cuenta como
        // "no existe" toda ruta de todo repo, que fue el error de la primera medición (daba 2,26%
        // de puro artefacto). Sobre las absolutas el número es EXACTO. Es un pedazo del universo,
        // y es el único donde la respuesta es verdadera.
        const abs = readPaths(cmd).map((g) => g.filter((x) => x.startsWith('/') && !/^\/(private\/)?(tmp|var)\//.test(x))).filter((g) => g.length);
        if (!abs.length) { sin_absolutas++; continue; }
        // La carpeta de usuario se le pide a `os.homedir()` y no a la variable HOME, que en Windows no existe (ahí la
        // da USERPROFILE). Es higiene, sin efecto en lo que se mide: acá sólo llegan rutas absolutas, y ésas no se
        // resuelven contra ninguna carpeta.
        const m = missing(abs, os.homedir(), true);
        if (m.length) { hablaria++; if (ej.length < 5) ej.push(`${m[0]}   ←   ${cmd.slice(0, 70)}`); }
      }
    }
    const usables = tot - truncados - indecidibles - sin_absolutas;
    console.log(`comandos Bash: ${tot}`);
    console.log(`  descartados: ${truncados} cortados · ${indecidibles} indecidibles (cd propio) · ${sin_absolutas} sin rutas absolutas de lectura`);
    console.log(`evaluables: ${usables}`);
    console.log(`el aviso habría hablado: ${hablaria}  (${(hablaria * 100 / Math.max(usables, 1)).toFixed(2)}%)`);
    ej.forEach((e) => console.log('   ej:', e));
    process.exit(0);
  }
  if (process.env.TYCON_MISSING_PATH_NOTICE === '0') process.exit(0);
  let payload = '';
  try { payload = fs.readFileSync(0, 'utf8'); } catch { process.exit(0); }
  try {
    const d = JSON.parse(payload || '{}');
    const cmd = (d.tool_input || {}).command || '';
    // Falso positivo dominante (40% de los comandos donde el hook opinaba): un comando con `cd` propio resuelve sus rutas relativas contra
    // OTRA carpeta, y este hook no puede saber cuál. El modo --measure ya descartaba estos casos
    // por injuzgables, y el modo producción hace lo mismo: sin esto, `cd scripts/x && head -60 archivo.js`
    // daría "no existe" sobre un archivo que se lee bien. Ante un cd: callado, como en la medición.
    if (/(^|[;&|]\s*)cd\s/.test(cmd)) process.exit(0);
    const m = missing(readPaths(cmd), (d.cwd && String(d.cwd)) || process.cwd());
    if (m.length) {
      // 🔴 stderr + exit 2, NO console.log: en PostToolUse el
      // stdout va SOLO al debug log — el agente jamás lo ve, y un control que escribe ahí queda INERTE
      // (según la doc oficial de hooks, únicamente UserPromptSubmit/SessionStart/
      // UserPromptExpansion inyectan stdout como contexto). El canal documentado que SÍ llega al
      // modelo en PostToolUse es stderr con exit 2 ("shows stderr to the model — tool already
      // ran": no bloquea nada, la herramienta ya corrió; sólo hace visible el aviso).
      process.stderr.write(
        `⚠️  Ese comando quiso LEER ${m.length === 1 ? 'una ruta que no existe' : 'rutas que no existen'}: ${m.join(', ')}\n` +
        '   Si te devolvió vacío, eso NO significa "no hay nada" — significa que miraste donde no\n' +
        '   está. Verificá la ruta antes de sacar conclusiones (incident-log#listado-vacio-2026-08-27).\n',
      );
      process.exit(2);
    }
  } catch { /* fail-open */ }
  process.exit(0);
}
