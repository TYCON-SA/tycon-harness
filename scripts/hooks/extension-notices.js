#!/usr/bin/env node
'use strict';
// extension-notices.js — dice los avisos de las extensiones activas que aplican (los `notices.json` de los paquetes y
// de los conectores de plataforma; scripts/lib/extension-notices.js decide cuáles). Así una regla que sólo sirve en
// ciertos repos, o con cierta plataforma, viaja con su extensión y no en las instrucciones de todas las sesiones.
//
// Dos momentos:
//   · al arrancar la sesión (SessionStart), los avisos `session-start`, como texto;
//   · después de un comando de la sesión (PostToolUse sobre Bash), los avisos `after-command` que ese comando dispara,
//     como contexto adicional del evento (`hookSpecificOutput.additionalContext`): es el canal que llega al modelo en
//     las dos herramientas. Sale aunque el comando haya fallado: una salida vacía puede ser un comando que falló. Claude
//     Code avisa el comando que falló con otro evento (PostToolUseFailure), que se atiende igual y se contesta con su
//     nombre; Codex manda PostToolUse en los dos casos.
// Cada aviso sale una vez por sesión, y otra vez después de compactar o limpiar la conversación (el arranque de ese
// momento borra lo dicho en la sesión). Lo dicho se anota agregando un renglón al archivo de la sesión, nunca
// reescribiéndolo: dos comandos que terminan a la vez no se pisan la marca. Sin `session_id`, el aviso de después del
// comando sale y no se recuerda. Un evento que no se lee no anota nada: el momento se busca en su texto, y uno de después
// del comando dice el problema por ese canal, sin los avisos del arranque. Un `notices.json` roto, o no poder saber qué
// está activo, se dice en una línea (después de un comando, una vez por sesión) y no frena. Sale 0 siempre y nunca trae
// una decisión.
// Off: TYCON_EXTENSION_NOTICES=0.
const fs = require('fs');
const os = require('os');
const path = require('path');

// La carpeta del estado la sabe scripts/setup/harness/tycon-home.js, si está al lado; suelto (el banco copia este hook
// así), la carpeta temporal. Se resuelve adentro de main(): si el módulo fallara al cargar, el gancho igual sale 0 y lo dice.
function stateDirOf(home) {
  const lib = path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js');
  return fs.existsSync(lib) ? require(lib).stateDir(home) : path.join(os.tmpdir(), 'tycon-state');
}

/**
 * El evento que manda la herramienta. Uno que llega y no se lee se dice: sin él, la carpeta y el momento son supuestos.
 * El momento se busca en el texto (`hook_event_name`): uno de después del comando no se contesta como un arranque.
 */
function readStdin() {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch (_) { return { input: {}, problem: null }; }
  if (!raw.trim()) return { input: {}, problem: null };
  try { return { input: JSON.parse(raw), problem: null }; } catch (e) {
    const m = /"hook_event_name"\s*:\s*"([A-Za-z]+)"/.exec(raw);
    return { input: m ? { hook_event_name: m[1] } : {}, problem: e.message };
  }
}

/** Lo ya dicho en la sesión: un renglón JSON por anotación (una lista o una clave); uno que no se lee se saltea. */
function leerDichos(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let v;
    try { v = JSON.parse(line); } catch (_) { continue; }
    for (const k of Array.isArray(v) ? v : [v]) if (typeof k === 'string') out.push(k);
  }
  return out;
}

// si el gancho falla, el aviso de la falla tiene que salir por el canal del momento en que corrió
let enComando = false;
// los dos eventos de después de un comando: el que salió bien y, en Claude Code, el que falló
const EVENTOS_DE_COMANDO = ['PostToolUse', 'PostToolUseFailure'];
let eventoDeComando = 'PostToolUse';

/** Después de un comando, el texto va como contexto adicional del evento: el texto suelto no le llega al modelo. */
const despuesDelComando = (text) => JSON.stringify({ hookSpecificOutput: { hookEventName: eventoDeComando, additionalContext: text } }) + '\n';

/** Los avisos que todavía no salieron en la sesión, leídos: `{ out, nuevos }`; un texto que no se lee va a `errors`. */
function porDecir(notices, shown, errors) {
  const out = [];
  const nuevos = [];
  for (const n of notices) {
    const key = `${n.extension}/${n.id}`;
    if (shown.includes(key)) continue;
    let text;
    try { text = fs.readFileSync(n.file, 'utf8').replace(/^﻿/, '').trim(); } catch (e) { errors.push(`el aviso ${key} no se pudo leer (${e.code || e.message})`); continue; }
    if (!text) { errors.push(`el aviso ${key} está vacío`); continue; }
    out.push(text);
    nuevos.push(key);
  }
  return { out, nuevos };
}

function main() {
  if (process.env.TYCON_EXTENSION_NOTICES === '0') return;
  const { input, problem: ilegible } = readStdin();
  const cwd = input.cwd || process.cwd();
  const conSesion = Boolean(input.session_id);
  // un subagente comparte la sesión con su madre: lo que se le dijo a él no está en el contexto de ella, y anota aparte
  const agente = typeof input.agent_id === 'string' && input.agent_id ? `--${input.agent_id}` : '';
  const sid = `${input.session_id || '_nosession'}${agente}`.replace(/[/\\]/g, '_');
  const lib = require(path.join(__dirname, '..', 'lib', 'extension-notices.js'));
  const comando = EVENTOS_DE_COMANDO.includes(input.hook_event_name);
  enComando = comando;
  if (comando) eventoDeComando = input.hook_event_name;
  const problem = !ilegible ? null : comando
    ? `el evento de después del comando no se pudo leer (${ilegible}): los avisos de ese comando no se evaluaron`
    : `el evento de arranque no se pudo leer (${ilegible}); se usó la carpeta actual`;

  const stateFile = path.join(stateDirOf(os.homedir()), 'extension-notices', `${sid}.json`);
  let shown = [];
  // después de compactar o de limpiar la conversación (mismo session_id, `source` compact o clear) lo dicho antes ya no
  // está en el contexto: se vuelve a decir, como se recargaba el CLAUDE.md (también lo de después de un comando)
  const contextoNuevo = !comando && (input.source === 'compact' || input.source === 'clear');
  // sin sesión no hay a quién recordarle nada: después de un comando, sale cada vez. Un evento que no se lee no es de
  // ninguna sesión: no lee ni anota lo dicho
  const recuerda = !ilegible && !(comando && !conSesion);
  if (!contextoNuevo && recuerda) shown = leerDichos(stateFile);
  // lo nuevo se agrega en un renglón (un comando que termina a la vez agrega el suyo); tras compactar o limpiar, el
  // archivo se reemplaza entero con uno temporal y un cambio de nombre
  const guardar = (nuevos) => {
    if (!recuerda) return;
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      if (!contextoNuevo) { fs.appendFileSync(stateFile, `\n${JSON.stringify(nuevos)}`); return; }
      const tmp = `${stateFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(nuevos));
      fs.renameSync(tmp, stateFile);
    } catch (_) { /* sin estado, el aviso puede repetirse en la sesión: mejor que no decirlo */ }
  };

  if (comando) {
    const command = String((input.tool_input || {}).command || '');
    if (!command.trim()) {
      if (problem) process.stdout.write(despuesDelComando(`⚠️ avisos de extensiones: ${problem}`));
      return;
    }
    // lo ya dicho en la sesión no se vuelve a mirar: así no se le pregunta a git por un aviso que no va a salir
    const { notices, errors } = lib.afterCommand({ cwd, command, powershell: input.tool_name === 'PowerShell', yaDichos: shown });
    if (problem) errors.unshift(problem);
    const { out, nuevos } = porDecir(notices, shown, errors);
    // un problema se dice una vez por sesión: este gancho corre después de cada comando
    for (const e of errors) { const key = `aviso-roto:${e}`; if (!shown.includes(key)) { out.push(`⚠️ avisos de extensiones: ${e}`); nuevos.push(key); } }
    if (out.length) process.stdout.write(despuesDelComando(out.join('\n\n')));
    if (nuevos.length) guardar(nuevos);
    return;
  }

  const { notices, errors } = lib.applicable({ cwd, when: 'session-start' });
  if (problem) errors.unshift(problem);
  const { out, nuevos } = porDecir(notices, shown, errors);
  for (const e of errors) out.push(`⚠️ avisos de extensiones: ${e}`);
  if (out.length) process.stdout.write(out.join('\n\n') + '\n');
  if (nuevos.length || contextoNuevo) guardar(nuevos);
}

try { main(); } catch (e) {
  const texto = `⚠️ avisos de extensiones: el gancho falló (${(e && e.message) || e}); la sesión sigue`;
  process.stdout.write(enComando ? despuesDelComando(texto) : `${texto}\n`);
}
process.exit(0);
