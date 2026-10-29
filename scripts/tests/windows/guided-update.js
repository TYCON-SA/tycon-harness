'use strict';
/**
 * guided-update.js — una máquina instalada siguiendo la página pública de Windows, con una versión anterior, que abre
 * una sesión cuando ya hay una versión nueva publicada. Lo llama `update-probe.js` cuando lo que se ensaya es una copia
 * publicada (trae `version.json`).
 *
 * POR QUÉ EXISTE. Cada máquina del equipo se actualiza sola al abrir una sesión, por la línea de arranque que dejó el
 * instalador. Sobre una versión bajada, en Windows, eso no lo había disparado nadie: ni con la capa del equipo (que
 * manda aplicar sola), ni sin ella (una máquina nueva avisa y pregunta), ni con `pwsh` fuera del PATH (la línea de
 * arranque de Windows empieza con `pwsh`).
 *
 * QUÉ HACE, por cada variante, en su propia carpeta de usuario de laboratorio:
 *   1. Publica una versión de juguete (N) en el GitHub de juguete y la instala con los comandos de la página.
 *   2. Publica la siguiente (N+1), saca al arranque de su ventana de red y abre sesiones disparando los hooks tal como
 *      quedaron registrados, con el desprendimiento prendido y esperando al trabajo que se desprende.
 *   3. «Se actualizó» se decide por el número de `version.json` del árbol instalado. Nunca por git.
 *
 * LAS VARIANTES
 *   auto           con la capa del equipo: tiene que quedar en N+1 sola. Foto y humo de cada hook antes y después.
 *   ask            sin la capa: NO tiene que cambiar de versión; el aviso de la versión nueva queda en el estado, el
 *                  hook de avisos se lo dice a la persona en la sesión siguiente, y `harness.js update --yes` lanzado
 *                  SIN una terminal se niega y no cambia nada (aplicarla lo decide una persona: no se ensaya).
 *   pwsh-missing   instalada con PowerShell 7 y con la capa; después `pwsh` no está en el PATH. Se anota si se
 *                  actualizó, qué devolvió cada hook de arranque y si algo le avisa a la persona.
 * «Sólo PowerShell 5.1» no es una variante: es la misma máquina que `pwsh-missing`.
 *
 * CÓMO FALLA. Una máquina que no se actualiza o que no avisa es un HECHO del reporte, con su gravedad; no se arregla
 * acá. «Error» es no haber podido ensayar.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const L = require('./lab.js');
const T = require('./team-lab.js');
const TL = require('./toy-lab.js');
const RP = require('./release-photo.js');
const GI = require('./guided-install.js');
const PZ = require('./pieces.js');

const NAME = 'update';
const VARIANTS = Object.freeze([
  // `required`: la principal del paso — si no puede ni empezar, el paso no ensayó (queda en «error», no en «medido»)
  { id: 'auto', home: ['users', 'update-auto'], team: true, pwsh_after: true, required: true, what: 'con la capa del equipo: aplica sola' },
  { id: 'ask', home: ['users', 'update-ask'], team: false, pwsh_after: true, what: 'sin la capa del equipo: avisa y pregunta' },
  // (la carpeta no se llama como la variante a propósito: su ruta aparece en lo que imprimen los hooks, y ahí se busca «pwsh»)
  { id: 'pwsh-missing', home: ['users', 'update-without-ps7'], team: true, pwsh_after: false, what: 'instalada con PowerShell 7 y con la capa; después pwsh no está en el PATH' },
  // sin la capa y sin ningún paquete activo, con la política de aplicar sola elegida en la máquina
  { id: 'no-pack', home: ['users', 'update-no-pack'], team: false, pwsh_after: true, apply_alone: true, what: 'sin la capa ni paquetes activos, con «aplicar sola» elegido en la máquina' },
  // dos sesiones que se abren a la vez con una versión nueva por aplicar, mientras otro programa (otra sesión, un
  // antivirus) tiene `settings.json` abierto sin dejar reemplazarlo
  { id: 'two-sessions', home: ['users', 'update-two-sessions'], team: false, pwsh_after: true, apply_alone: true, together: true, what: 'aplica sola con dos sesiones abriéndose a la vez y settings.json tomado por otro programa' },
]);
/**
 * La mudanza de juguete que trae la versión nueva: la de antes tiene una skill y un agente en el núcleo; la
 * nueva los tiene dentro de un paquete. Con un paquete activo la máquina no pierde nada; sin ninguno, salen ellos dos (y
 * sólo ellos), y se dice en una línea. Nombres inventados.
 */
const MOVED = Object.freeze({ skill: 'lab-mudada', agent: 'rev-lab-mudado', pack: 'lab-mudanza' });
const movedSkill = `---\nname: ${MOVED.skill}\ndescription: skill de juguete que se muda a un paquete (ensayo)\n---\nUsala para probar.\n`;
const movedAgent = `---\nname: ${MOVED.agent}\ndescription: revisor de juguete que se muda a un paquete (ensayo)\nmodel: sonnet\ntools: Read\n---\n\nRevisa cosas de juguete.\n`;
/** Los cambios de la versión de antes (`before`) o de la nueva (`after`), para `toy-lab.publish`. */
function moveChanges(stage) {
  const P = `packs/${MOVED.pack}`;
  if (stage === 'before') return [{ rel: `skills/${MOVED.skill}/SKILL.md`, text: movedSkill }, { rel: `agents/${MOVED.agent}.md`, text: movedAgent }, { rel: P, remove: true }];
  return [
    { rel: `skills/${MOVED.skill}`, remove: true }, { rel: `agents/${MOVED.agent}.md`, remove: true },
    { rel: `${P}/pack.json`, text: `${JSON.stringify({ name: MOVED.pack, description: 'paquete de juguete de la mudanza (ensayo)', skills: 'skills', agents: 'agents', reviewers: [{ agent: MOVED.agent, group: 'condicional', when: { files: '^lab-nunca/' }, surface: { paths: ['lab-nunca/**'] }, depth: 'standard', prefixes: ['LABM'] }] }, null, 2)}\n` },
    { rel: `${P}/skills/${MOVED.skill}/SKILL.md`, text: movedSkill }, { rel: `${P}/agents/${MOVED.agent}.md`, text: movedAgent },
  ];
}
/** La línea con que el aplicador dice que sacó las piezas de un paquete que la organización no activa. */
const PACK_LINE = /pieza\(s\) de paquete\(s\) que la organización no activa/;
// con qué pasos de la página se instala la versión de antes (lo demás del alta lo mide el paso del alta)
const INSTALL_STEPS = Object.freeze(['install', 'git-hooks']);
// en qué orden se abren las sesiones de la variante que aplica sola: [nombre, forma de lanzar]. La cuarta está para
// comparar dos sesiones ya actualizadas (la tercera puede ser la primera en que corre el programa nuevo)
const SESSIONS = Object.freeze([['después-1', 'bash-c'], ['después-2', 'default-shell'], ['después-3', 'default-shell'], ['después-4', 'default-shell']]);
const SAME_MACHINE_NOTE = '«Sólo PowerShell 5.1» no es una variante aparte de la actualización: es la misma máquina que `pwsh-missing` (no se puede tener una versión instalada sin haber tenido PowerShell 7).';
// lo que cuenta como «algo le avisa a la persona» en la salida de un hook o en el diagnóstico: que nombre a pwsh (como
// palabra, no como parte de una ruta) o que diga que el arnés no se está actualizando
const TELLS = /(^|[^\w/\\.-])pwsh(?![\w-])|PowerShell 7|no se actualiz|sin actualizar|no se est[aá] actualizando|arn[eé]s atrasado/i;
const round = (ms) => Math.round(ms / 100) / 10;
const linesOf = (s) => (s.hooks || []).flatMap((h) => `${h.out || ''}\n${h.err || ''}`.split('\n')).map((l) => l.trim()).filter(Boolean);
/**
 * Lo que una sesión LE DICE A LA PERSONA: la salida de sus hooks, SIN la de la línea de arranque. Esa línea queda
 * registrada como trabajo de fondo y lo que imprime no llega a la conversación; y si no arranca, lo que hay en su canal
 * de errores es el error del shell («pwsh: command not found»), que tampoco es un aviso del arnés.
 */
const toldBy = (s) => linesOf({ hooks: (s.hooks || []).filter((h) => !h.startup) });

/**
 * La máquina que pregunta: ¿se enteró la persona de que hay una versión nueva? `sessions` son las dos sesiones (la que
 * mira la red y la siguiente); `published`, el número de la versión publicada; `before` y `after`, la versión instalada
 * antes y después de abrirlas. No actualizarse sola no es un hallazgo acá: es lo esperado.
 *   · cambió sola de versión → `update:ask:applied-by-itself` (y nada más: el aviso ya no tiene por qué estar);
 *   · el estado no guarda el aviso DE LA VERSIÓN NUEVA (el que nombra su número) → `update:ask:no-notice`. Otro aviso
 *     cualquiera no cuenta: el estado guarda ahí también «no pude mirar la red» o «el permiso venció»;
 *   · lo guarda y ningún hook de la sesión siguiente se lo dice → `update:ask:notice-not-shown`.
 */
function judgeAsk({ state_notice: notice, sessions, published = null, before = null, after = null }) {
  const findings = [];
  // `hook_checked`: si se llegó a mirar lo que dijeron los hooks (sin el aviso en el estado no hay qué buscar en ellos:
  // «no dijo nada» y «no se miró» no son lo mismo, y el reporte los distingue)
  const told = { state_notice: notice || null, hook_said: null, hook_checked: false };
  // sin el número de después no se juzga nada por la versión (quien llama ya dejó `version:unreadable`)
  if (!after) return { findings, what_the_dev_is_told: told, cannot_tell: true };
  if (before && after !== before) {
    findings.push({ id: 'update:ask:applied-by-itself', severity: T.SEVERITY.loses, kind: 'update', detail: `la máquina que pregunta cambió sola de versión al abrir las sesiones (${before} → ${after}): sin la capa del equipo tenía que avisar y esperar a la persona` });
    return { findings, what_the_dev_is_told: told };
  }
  const text = String(notice || '').trim();
  const names = Boolean(text) && Boolean(published) && text.includes(String(published));
  if (!names) {
    findings.push({ id: 'update:ask:no-notice', severity: T.SEVERITY.loses, kind: 'update', detail: `con la versión ${published || 'nueva'} publicada y la máquina fuera de su ventana, el estado del arnés no guarda el aviso de esa versión${text ? ` (lo que guarda es otro aviso: «${L.clip(text, 200)}»)` : ''}: la persona no tiene de dónde enterarse` });
    return { findings, what_the_dev_is_told: told };
  }
  told.hook_checked = true;
  for (const s of sessions.slice(1)) {
    told.hook_said = toldBy(s).find((l) => l.includes(text) || l.includes(String(published))) || null;
    if (told.hook_said) { told.hook_said = L.clip(told.hook_said, 500); break; }
  }
  if (!told.hook_said) findings.push({ id: 'update:ask:notice-not-shown', severity: T.SEVERITY.loses, kind: 'update', detail: `el estado guarda el aviso («${L.clip(text, 200)}») y ningún hook de la sesión siguiente se lo dice a la persona` });
  return { findings, what_the_dev_is_told: told };
}

/**
 * La máquina que pregunta, cuando alguien lanza `update --yes` SIN una terminal: el programa tiene que negarse (aplicar
 * una versión lo decide una persona) y la máquina no cambia. Negarse es lo esperado; aplicar igual es el hallazgo.
 * `refused_cleanly`: no cambió de versión, salió distinto de 0 y dijo que hace falta una terminal.
 */
function judgeByHand({ exit, error = null, said = '', version_before: before, version_after: after }) {
  const findings = [];
  // sin el número de después no se juzga: ni «aplicó», ni «se negó limpio» (`refused_cleanly` nulo: no se sabe)
  if (!after) return { findings, refused_cleanly: null };
  const changed = after !== before;
  if (changed) findings.push({ id: 'update:ask:applied-without-a-person', severity: T.SEVERITY.loses, kind: 'update', detail: `«harness.js update --yes», lanzado sin una terminal, aplicó la versión nueva (${before} → ${after}): en una máquina que pregunta, aplicar lo decide una persona` });
  return { findings, refused_cleanly: !changed && !error && exit !== 0 && /terminal/i.test(String(said || '')) };
}

/**
 * La máquina sin `pwsh`: si no se actualizó, se dice; y si además nada se lo avisa a la persona, también. «Algo le
 * avisa» es: algún hook de la sesión imprime un texto sobre eso, o el diagnóstico marca el requisito que falta. Lo que
 * devuelve la propia línea de arranque NO cuenta (ver `toldBy`): el error del shell por no encontrar `pwsh` nombra a
 * `pwsh`, y con él toda máquina «avisaría».
 */
function judgePwshMissing({ updated, sessions, doctor }) {
  const startup = sessions.flatMap((s) => (s.hooks || []).filter((h) => h.startup).map((h) => ({ session: s.label, form: s.form, exit: h.exit, error: h.error || null, said: L.clip(T.tellingLine(h.err) || L.firstLine(h.out), 300) })));
  const hook = sessions.flatMap(toldBy).find((l) => TELLS.test(l)) || null;
  const flagged = doctor && doctor.readable ? [...(doctor.fail || []), ...(doctor.warn || [])].find((l) => TELLS.test(l) || /PowerShell/i.test(l)) || null : null;
  const findings = [];
  // (`updated` es de tres estados: nulo —no se pudo leer la versión— no es «no se actualizó»)
  if (updated === false) {
    findings.push({ id: 'update:pwsh-missing:not-updated', severity: T.SEVERITY.loses, kind: 'update', detail: `sin pwsh en el PATH la máquina no se actualizó: ${startup.map((h) => `la línea de arranque, lanzada por ${h.form}, ${h.error ? `no arrancó (${h.error})` : `salió ${h.exit}`}${h.said ? ` — ${h.said}` : ''}`).join(' · ') || 'no hay línea de arranque que disparar'}` });
    if (!hook && !flagged) findings.push({ id: 'update:pwsh-missing:silent', severity: T.SEVERITY.loses, kind: 'update', detail: 'sin pwsh en el PATH la máquina no se actualizó y nada se lo avisa a la persona: ningún hook de la sesión lo dice y el diagnóstico no marca el requisito que falta' });
  }
  return { findings, startup_hooks: startup, something_tells: { hook: hook ? L.clip(hook, 400) : null, doctor: flagged ? L.clip(flagged, 400) : null } };
}

/**
 * ¿Quedó instalada la versión de antes? `read` es lo que dijo `toy-lab.versionFacts` del árbol instalado. Sin ella no
 * hay actualización que ensayar: `install-failed`, que rompe (y la variante termina ahí).
 */
function judgeInstalled({ wanted, read }) {
  if (read && read.number === wanted) return [];
  const found = read && read.number ? read.number : `que no hay versión${read && read.problem ? ` legible (${read.problem})` : ''}`;
  return [{ id: 'install-failed', severity: T.SEVERITY.breaks, kind: 'install', detail: `no se pudo instalar la versión de antes (${wanted}) con los comandos de la página: el árbol instalado dice ${found}` }];
}

/**
 * Lo que se lee del número de versión DESPUÉS de abrir sesiones (`read` es lo de `toy-lab.versionFacts`; `when`, en qué
 * momento). Sin número —el archivo ya no está, o no se deja leer— es `version:unreadable`, que rompe: no es «no cambió»
 * ni «no se actualizó».
 */
function judgeVersionRead(read, when) {
  if (read && read.number) return [];
  return [{ id: 'version:unreadable', severity: T.SEVERITY.breaks, kind: 'version', detail: `${when}, el árbol instalado no trae un número de versión legible (${(read && read.problem) || 'ya no hay version.json'}): no se sabe en qué versión quedó la máquina` }];
}

/**
 * La máquina que aplica sola, después de las sesiones: ¿llegó a la versión publicada? Tres estados, y de acá sale qué
 * se hace después:
 *   · llegó              → `reached: true`, sin hallazgos;
 *   · quedó en otra      → `reached: false`, `version:not-applied`, y `by_hand` (se la actualiza a mano, como haría una
 *                          persona, para que la foto de después sea la de una máquina actualizada);
 *   · no se pudo leer    → `reached: null`, `version:unreadable`, y NADA más: ni «no se actualizó», ni actualizar a mano.
 */
function judgeReached(read, when, { expected, sessions = 0 } = {}) {
  const findings = judgeVersionRead(read, when);
  const number = (read && read.number) || null;
  const reached = number ? number === expected : null;
  if (reached === false) findings.push({ id: 'version:not-applied', severity: T.SEVERITY.loses, kind: 'version', detail: `después de ${sessions} sesión(es) la máquina seguía en la versión ${number} y no en la ${expected}: no se actualizó sola` });
  return { number, reached, by_hand: reached === false, findings };
}

// los temporales que deja una escritura atómica de `settings.json` a su lado (el arnés y el aplicador)
const SETTINGS_TEMP = /^\.settings\..*\.tmp$|^settings\.json\.tmp/;
/**
 * Dos sesiones abiertas a la vez durante una actualización, con `settings.json` tomado por otro programa. `pair`: cómo
 * salió la línea de arranque de cada una; `settings`: `{ readable, startup }` al final; `leftovers`: los temporales que
 * quedaron al lado de `settings.json`; `failed`: el intento fallido que guarda el estado al final (o nulo). Que llegue a
 * la versión nueva lo juzga `judgeReached`.
 *   · una línea de arranque que no sale 0 → `two-sessions:startup-failed:<sesión>` (rompe);
 *   · `settings.json` ilegible o sin la línea de arranque → `two-sessions:settings-broken` (rompe);
 *   · un intento fallido que no es «interrumpido» (ése no se reintenta solo) → `two-sessions:failed-not-retried`;
 *   · temporales a su lado → `two-sessions:temp-left` (ruido).
 */
function judgeTwoSessions({ pair = [], settings, leftovers = [], failed = null }) {
  const findings = [];
  for (const p of pair) if (p.error || p.exit !== 0) findings.push({ id: `two-sessions:startup-failed:${p.label}`, severity: T.SEVERITY.breaks, kind: 'startup', detail: `la línea de arranque de la sesión ${p.label} salió ${p.error || p.exit} con la otra abriéndose a la vez${p.err ? `: ${L.clip(p.err.trim(), 300)}` : ''}` });
  if (!settings || !settings.readable) findings.push({ id: 'two-sessions:settings-broken', severity: T.SEVERITY.breaks, kind: 'settings', detail: 'después de la actualización settings.json no se deja leer' });
  else if (!settings.startup) findings.push({ id: 'two-sessions:settings-broken', severity: T.SEVERITY.breaks, kind: 'settings', detail: 'después de la actualización settings.json ya no tiene la línea de arranque del arnés' });
  if (failed && failed.reason !== 'interrupted') findings.push({ id: 'two-sessions:failed-not-retried', severity: T.SEVERITY.loses, kind: 'version', detail: `el estado guarda un intento fallido («${failed.reason || 'sin motivo'}») que la sesión siguiente no reintenta sola` });
  if (leftovers.length) findings.push({ id: 'two-sessions:temp-left', severity: T.SEVERITY.noise, kind: 'settings', detail: `quedaron temporales al lado de settings.json: ${leftovers.join(', ')}` });
  return findings;
}

// lanza cada trabajo de una lista a la vez y espera a todos; imprime cómo salió cada uno (lo usa `fireTogether`)
const TOGETHER_RUNNER = `const { spawn } = require('child_process');
const jobs = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));
const out = [];
let left = jobs.length;
jobs.forEach((j, i) => {
  // stable-data: el reloj sólo mide cuánto tardó cada sesión, para el informe; no decide ningún resultado
  const t0 = Date.now();
  let so = '', se = '';
  const c = spawn(j.bin, j.args, Object.assign({ cwd: j.cwd, env: j.env, windowsHide: true }, j.opts || {}));
  const timer = setTimeout(() => c.kill(), j.timeoutMs);
  c.stdout.on('data', (d) => { so += d; });
  c.stderr.on('data', (d) => { se += d; });
  c.on('error', (e) => { out[i] = Object.assign({}, out[i], { error: e.code || e.message }); });
  c.on('close', (code) => {
    clearTimeout(timer);
    out[i] = Object.assign({ label: j.label, exit: code, ms: Date.now() - t0, out: so.slice(-2000), err: se.slice(-2000) }, out[i]);
    if (--left === 0) process.stdout.write(JSON.stringify(out));
  });
  c.stdin.end(j.input);
});
`;
/** La línea de arranque de `settings.json`, lanzada por `form` en dos sesiones A LA VEZ: `[{ label, exit, error, ms, out, err }]`. */
function fireTogether({ form, settingsFile, home, env, scratch, labels, seen }) {
  const line = T.registeredStartup(settingsFile);
  if (!line) throw new Error('no hay línea de arranque en settings.json para lanzar las dos sesiones');
  const input = JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd: home, session_id: 'dos-a-la-vez' });
  const jobs = labels.map((label, i) => {
    const [bin, args, opts] = form.launch(line.command, `j${i}`);
    return { label, bin, args, opts, cwd: home, env, input, timeoutMs: 120000 };
  });
  fs.mkdirSync(scratch, { recursive: true });
  const runner = path.join(scratch, 'together.js');
  const list = path.join(scratch, 'together.json');
  fs.writeFileSync(runner, TOGETHER_RUNNER);
  fs.writeFileSync(list, JSON.stringify(jobs));
  try {
    const r = seen(L.run(process.execPath, [runner, list], { env, cwd: home, timeoutMs: 300000, cap: 400000 }), 'las dos sesiones a la vez');
    if (r.error || r.exit !== 0) throw new Error(`no pude lanzar las dos sesiones a la vez (salió ${r.error || r.exit}: ${L.firstLine(r.stderr)})`);
    return JSON.parse(r.stdout).map((x) => Object.assign(x, { out: L.clip(x.out || '', 600), err: L.clip(x.err || '', 600) }));
  } finally { fs.rmSync(list, { force: true }); }
}

/**
 * Otro programa abre `file` como lo abre un antivirus o un editor: se deja leer, no escribir ni reemplazar (en Windows;
 * en otro sistema el archivo queda abierto y nada más). Devuelve `{ release() }` cuando ya lo tiene tomado.
 */
function holdOpen({ file, ps, env, scratch }) {
  fs.mkdirSync(scratch, { recursive: true });
  const script = path.join(scratch, 'hold.ps1');
  const ready = path.join(scratch, 'hold.ready');
  const release = path.join(scratch, 'hold.release');
  const done = path.join(scratch, 'hold.done');
  for (const f of [ready, release, done]) fs.rmSync(f, { force: true });
  fs.writeFileSync(script, "param($File, $Ready, $Release, $Done)\n$f = [IO.File]::Open($File, 'Open', 'Read', 'Read')\nNew-Item -ItemType File -Path $Ready -Force | Out-Null\n$n = 0\nwhile (-not (Test-Path $Release) -and $n -lt 1500) { Start-Sleep -Milliseconds 200; $n++ }\n$f.Close()\nNew-Item -ItemType File -Path $Done -Force | Out-Null\n");
  // (sin desprender: en el agente de Windows un pwsh desprendido desde node no llega a arrancar)
  const child = spawn(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, file, ready, release, done], { env, stdio: 'ignore', windowsHide: true });
  child.unref();
  // stable-data: el reloj sólo mide las esperas (que tome el archivo, que lo suelte), con su tope; ningún dato que se compara
  const t0 = Date.now();
  while (!fs.existsSync(ready) && Date.now() - t0 < 60000) TL.sleep(200);
  if (!fs.existsSync(ready)) { try { child.kill(); } catch (_) { /* ya no está */ } throw new Error('el programa que toma settings.json no lo abrió en 60 s'); }
  return {
    took_ms: Date.now() - t0,
    release() {
      fs.writeFileSync(release, '');
      const t1 = Date.now();
      // (soltó = dejó su marca después de cerrar el archivo: un proceso que ya terminó puede seguir figurando vivo)
      while (!fs.existsSync(done) && Date.now() - t1 < 10000) TL.sleep(200);
      return { released: fs.existsSync(done) };
    },
  };
}

/**
 * La lista de piezas antes y después: `{ before, after, before_text, after_text, diff, findings }`.
 * Con un paquete activo (`packActive`) la máquina no pierde ninguna pieza; sin ninguno, salen exactamente la skill y el
 * agente de la mudanza de juguete (`MOVED`), y la máquina lo dice en UNA línea (`packLine`). Cualquier otra pieza que
 * salga, una que tendría que haber salido y quedó, o la línea que falta o se repite, es un hallazgo.
 */
function judgePieces({ before, after, renames = {}, packActive, packLine }) {
  const findings = [];
  if (!before || !after) return { before: before || null, after: after || null, diff: null, findings: [{ id: 'pieces:not-measured', severity: T.SEVERITY.loses, kind: 'pieces', detail: 'no se pudo tomar la lista de piezas de antes o de después' }] };
  const diff = PZ.compare(before, after, { renames });
  const moved = [`skills/${MOVED.skill}`, `agents/${MOVED.agent}.md`];
  const key = (x) => `${x.kind}/${x.name}`;
  const expectedLost = packActive ? [] : moved;
  const lostBeyond = diff.lost.filter((x) => !expectedLost.includes(key(x)));
  if (lostBeyond.length) findings.push({ id: 'pieces:lost', severity: T.SEVERITY.loses, kind: 'pieces', detail: `después de actualizar la máquina no tiene ${lostBeyond.map(key).join(', ')}` });
  const kept = expectedLost.filter((k) => !diff.lost.some((x) => key(x) === k));
  if (kept.length) findings.push({ id: 'pieces:pack-kept', severity: T.SEVERITY.noise, kind: 'pieces', detail: `sin ningún paquete activo siguen enlazadas ${kept.join(', ')}, que la versión nueva trae dentro de un paquete` });
  if (diff.gained.length) findings.push({ id: 'pieces:gained', severity: T.SEVERITY.noise, kind: 'pieces', detail: `después de actualizar aparecen ${diff.gained.map(key).join(', ')}` });
  if (!packActive && diff.lost.length && packLine.count !== 1) findings.push({ id: 'pieces:pack-line', severity: T.SEVERITY.loses, kind: 'pieces', detail: `salieron piezas de un paquete y la máquina lo dijo ${packLine.count} vez/veces (tiene que ser una línea, con el motivo y dónde se activa)` });
  return { before, after, before_text: PZ.text(before), after_text: PZ.text(after), diff, findings };
}

/** La carpeta global de hooks de git de una carpeta de usuario de laboratorio: el valor, si es la del arnés y si su pre-push está. */
function hooksPathFacts(home, env) {
  const r = L.run('git', ['config', '--global', '--get', 'core.hooksPath'], { env, timeoutMs: 60000 });
  const expected = path.join(home, '.git-hooks');
  const value = String(r.stdout || '').trim() || null;
  let prePush = false;
  try { prePush = require('fs').readFileSync(path.join(expected, 'pre-push'), 'utf8').includes('git-pre-push-global.sh'); } catch (_) { prePush = false; }
  return { exit: r.exit, value, expected, same: Boolean(value) && L.samePath(value.replace(/\//g, path.sep), expected), pre_push: prePush };
}

function runVariant({ ctx, v, facts, save, lab, out, platform, allowTemp, baseEnv, rec, add, say, publishNext, waitCapMs, waitBudgetMs }) {
  const opened = GI.openVariant({ ctx, lab, prefix: NAME, v, facts, platform, allowTemp, baseEnv });
  if (!opened) return false;
  const { home, scratch, env, window } = opened;
  const ps = L.scanPath('pwsh', { env, platform })[0] || null;
  if (!ps) { facts.not_run = 'no hay pwsh en esta máquina con qué instalar la versión de antes: la página pide PowerShell 7'; return false; }
  let bare = null;
  if (!v.pwsh_after) {
    bare = T.withoutPwsh(env, platform);
    if (bare.problem) { facts.not_run = bare.problem; return false; }
    facts.pwsh_removed_from = bare.removed;
  }
  // lo que el laboratorio cambió lo anota toda variante que corre, con lo propio de ella
  GI.noteLabChanges(rec, { ctx, v, home, changes: opened.changes, ps, env, scratch, own: bare ? { pwsh_removed_from: bare.removed, when: 'después de instalar la versión de antes' } : {} });
  const count = (sev) => rec.step.findings.filter((f) => f.variant === v.id && f.severity === sev).length;
  const bySeverity = () => ({ breaks: count(T.SEVERITY.breaks), 'loses-control': count(T.SEVERITY.loses), noise: count(T.SEVERITY.noise) });
  // toda salida que se mira pasa por acá: los permisos se buscan en la cruda y lo que sigue usa la tapada
  const seen = (raw, where) => { const safe = TL.checked(raw, ctx.tokens, where); for (const f of safe.findings) add(f); return safe.clean; };

  // 1 · la versión de antes, instalada con los comandos de la página (cada comando queda en el parcial apenas termina)
  const first = publishNext('before');
  say(`update: ${v.id} — instalo la versión ${first} con la página (${v.what}) en ${home}`);
  facts.install = { steps: INSTALL_STEPS, commands: [] };
  GI.followPage({ ctx, home, env, ps, scratch, cwd: window, id: `${NAME}-${v.id}`, only: INSTALL_STEPS, platform, say, commands: facts.install.commands, each: (found) => { for (const f of found) add(f, 'install:'); save(); } });
  const tree = path.join(home, '.tycon', 'harness');
  const read = TL.versionFacts(tree);
  facts.version_before = read.number;
  save();
  const notInstalled = judgeInstalled({ wanted: first, read });
  if (notInstalled.length) {
    for (const f of notInstalled) add(f);
    facts.answers = { by_severity: bySeverity() };
    return true;
  }
  const paths = TL.statePaths({ home, env, tree });
  if (paths.problem) throw new Error(paths.problem);
  const settings = path.join(home, '.claude', 'settings.json');
  let sessionEnv = env;
  if (v.team) {
    const team = GI.addTeam({ ctx, home, env, tree, paths });
    facts.team = team.facts;
    for (const f of team.findings) add(f);
    sessionEnv = team.env;
    save();
  }
  // sin la capa, lo que una persona elige en su máquina: que se actualice sola (la política de fábrica es preguntar) y
  // ningún paquete (la página instala con `--packs all`)
  if (v.apply_alone) {
    facts.apply_set = [];
    for (const [k, val] of [['update.apply', 'auto'], ['packs.default', 'none']]) {
      const set = L.run(process.execPath, [path.join(tree, 'scripts', 'lib', 'tycon-config.js'), 'set', k, val], { env: sessionEnv, cwd: home, timeoutMs: 60000 });
      const said = L.clip(L.firstLine(set.stdout) || L.firstLine(set.stderr), 300);
      facts.apply_set.push({ key: k, value: val, exit: set.exit, error: set.error || null, said });
      if (set.error || set.exit !== 0) throw new Error(`no pude elegir ${k} ${val} en la máquina (tycon-config.js set salió ${set.error || set.exit}: ${said})`);
    }
  }
  const scratchPieces = path.join(scratch, 'pieces');
  // el número de versión del árbol instalado, EN ESTE MOMENTO. Sin número —el archivo ya no está, o no se deja leer— no
  // hay de qué decir «cambió» ni «no cambió»: queda `version:unreadable` (rompe) y quien llama no juzga por la versión
  const versionNow = (when) => {
    const now = TL.versionFacts(tree);
    for (const f of judgeVersionRead(now, when)) add(f);
    return now.number;
  };
  const cannotTell = () => { facts.answers = { by_severity: bySeverity() }; say(`update: ${v.id} — no se pudo leer en qué versión quedó la máquina: no se juzga por la versión`); save(); return true; };
  // con qué formas se lanza cada sesión: la que la máquina no tiene queda dicha (no «se lanzó de dos formas» callando una)
  const missingForms = (forms, wanted) => { const none = wanted.filter((id) => !forms[id]); if (none.length) rec.note(`${v.id}: esta máquina no tiene con qué lanzar por ${none.join(', ')}: las sesiones se abrieron sólo por ${wanted.filter((id) => forms[id]).join(', ') || 'ninguna forma'}`); };
  const budget = { left_ms: waitBudgetMs };
  const open = (forms, formId, label, e) => {
    const s = TL.fireSession({ form: forms[formId], home, env: e, label, paths, secrets: ctx.tokens, capMs: waitCapMs, budget });
    s.version = TL.installedVersion(tree);
    say(`update: ${v.id} — sesión ${label} (${formId}): ${s.problem ? `NO se pudo abrir (${s.problem})` : `la línea de arranque salió ${((s.hooks || []).find((h) => h.startup) || {}).exit}; ${s.wait && s.wait.detached ? `se desprendió y esperé ${round(s.wait.waited_ms)} s (${s.wait.ended_by})` : 'no se desprendió'}`}; versión ${s.version}`);
    return s;
  };
  // toda sesión que el ensayo abre se juzga igual (`toy-lab.sessionFindings`). Las de la variante que aplica sola
  // entran además a la comparación de fotos, que usa ese mismo juicio
  const judgeSessions = (list, prefix = '', opts = {}) => { for (const s of list) for (const f of TL.sessionFindings(s, opts)) add(f, prefix); };
  // la carpeta global de hooks de git: la máquina del equipo instalada antes de que el arranque la pusiera no la tiene (la
  // página la pone a mano). Con la capa (política auto) el arranque se la tiene que poner solo: se la saca acá —la clave
  // y su anotación en el estado, como en una máquina que el arnés nunca tocó— y se mira después de las sesiones
  if (v.id === 'auto') {
    const un = L.run('git', ['config', '--global', '--unset', 'core.hooksPath'], { env: sessionEnv, timeoutMs: 60000 });
    try { const st = TL.stateOf(paths); if (st && st.git_hooks_path) { delete st.git_hooks_path; L.writeJsonAtomic(paths.file, st); } } catch (e) { throw new Error(`no pude simular la máquina sin la carpeta global de hooks: ${e.message}`); }
    facts.hooks_path_before = hooksPathFacts(home, sessionEnv);
    facts.hooks_path_before.unset_exit = un.exit;
    if (facts.hooks_path_before.value) throw new Error(`no pude simular la máquina sin la carpeta global de hooks: git sigue diciendo ${facts.hooks_path_before.value}`);
    save();
  }
  const forms = T.launchForms({ env: sessionEnv, platform, scratch });
  const smokeForms = ['bash-c', 'default-shell'].map((id) => forms[id]).filter(Boolean);
  // una sesión con la versión de antes: la máquina queda asentada (el arranque mira, y no hay nada nuevo)
  facts.settled = open(forms, 'default-shell', 'antes', sessionEnv);
  judgeSessions([facts.settled], 'before:');
  const alone = !v.together && (v.id === 'auto' || v.apply_alone === true);
  if (alone) {
    facts.before = RP.photo({ home, tree, env: sessionEnv, paths, platform, scratch: scratchPieces });
    // la máquina de antes, ya con la capa, se juzga por sí sola: después sólo es la base de la comparación
    for (const d of RP.judgePhoto(facts.before)) add(d, 'before:');
    facts.before_smoke = T.smoke({ settingsFile: settings, forms: smokeForms, home, scratch, env: sessionEnv, platform });
    try { if (facts.before.settings.exists && !facts.before.settings.problem) L.writeJsonAtomic(path.join(out, `settings-update-${v.id}-before.json`), ctx.redact(T.readJsonLoose(settings).value)); } catch (_) { /* la copia es de cortesía */ }
  }
  save();

  // 2 · se publica la versión nueva y el arranque sale de su ventana de red
  const next = publishNext('after');
  facts.version_published = next;
  facts.out_of_window = TL.outOfWindow(paths);
  // sin sacarla de su ventana, la máquina no mira la red: un «no se actualizó» o un «no avisó» no dirían nada. Eso no
  // es un hallazgo de la máquina: es no poder ensayar
  if (!facts.out_of_window.done) throw new Error(`no pude sacar al arranque de su ventana de red: ${facts.out_of_window.why}`);

  if (v.together) {
    // otro programa toma settings.json, y dos sesiones se abren a la vez: las dos ven la versión nueva
    const held = holdOpen({ file: settings, ps, env: sessionEnv, scratch: path.join(scratch, 'hold') });
    const marks = TL.detachedMarks(paths.harnessDir);
    let pair;
    let wait;
    try {
      pair = fireTogether({ form: forms['default-shell'], settingsFile: settings, home, env: sessionEnv, scratch: path.join(scratch, 'together'), labels: ['una', 'otra'], seen });
      wait = TL.waitDetached({ harnessDir: paths.harnessDir, lockDir: paths.lockDir, before: marks, capMs: waitCapMs, budget });
    } finally { facts.hold = Object.assign({ took_ms: held.took_ms }, held.release()); }
    const stHeld = TL.stateOf(paths);
    facts.while_held = { pair: pair.map(({ label, exit, error, ms }) => ({ label, exit, error, ms })), wait, version: TL.installedVersion(tree), failed: stHeld && stHeld.failed ? { reason: stHeld.failed.reason || null } : null };
    say(`update: ${v.id} — dos sesiones a la vez con settings.json tomado: salieron ${pair.map((p) => p.error || p.exit).join(' y ')}; ${wait.detached ? `esperé ${round(wait.waited_ms)} s (${wait.ended_by})` : 'no se desprendió'}; versión ${facts.while_held.version}`);
    save();
    // suelto el archivo: la sesión siguiente, de nuevo fuera de su ventana de red, termina lo que haya quedado a medias
    facts.out_of_window_again = TL.outOfWindow(paths);
    if (!facts.out_of_window_again.done) throw new Error(`no pude sacar al arranque de su ventana de red otra vez: ${facts.out_of_window_again.why}`);
    const next1 = open(forms, 'default-shell', 'después-de-soltar', sessionEnv);
    facts.sessions = [next1];
    judgeSessions([next1]);
    const reached = judgeReached(TL.versionFacts(tree), 'después de soltar settings.json y abrir otra sesión', { expected: next, sessions: 3 });
    for (const f of reached.findings) add(f);
    facts.version_after = reached.number;
    facts.updated = reached.reached;
    const st = TL.stateOf(paths);
    let readable = true;
    try { T.readJsonLoose(settings); } catch (_) { readable = false; }
    const leftovers = fs.readdirSync(path.dirname(settings)).filter((n) => SETTINGS_TEMP.test(n));
    facts.end = { settings: { readable, startup: Boolean(T.registeredStartup(settings)) }, leftovers, failed: st && st.failed ? { reason: st.failed.reason || null } : null };
    for (const f of judgeTwoSessions({ pair, settings: facts.end.settings, leftovers, failed: facts.end.failed })) add(f);
    facts.answers = { by_severity: bySeverity() };
    say(`update: ${v.id} — quedó en ${facts.version_after || 'una versión que no se pudo leer'}${facts.updated ? ' (la nueva)' : ' (NO la nueva)'}; settings.json ${readable ? 'legible' : 'ILEGIBLE'}; intento fallido en el estado: ${facts.end.failed ? facts.end.failed.reason : 'ninguno'}`);
  } else if (alone) {
    const sessions = SESSIONS.filter(([, formId]) => forms[formId]).map(([label, formId]) => open(forms, formId, label, sessionEnv));
    facts.sessions = sessions;
    missingForms(forms, ['bash-c', 'default-shell']);
    // tres estados (`judgeReached`): llegó, no llegó, o no se sabe — sin número no se dice «no se actualizó» ni se la
    // actualiza a mano (la comparación de fotos deja el mismo `version:unreadable`)
    const reached = judgeReached(TL.versionFacts(tree), 'después de las sesiones', { expected: next, sessions: sessions.length });
    for (const f of reached.findings) add(f);
    facts.version_after = reached.number;
    facts.updated_by_itself = reached.reached;
    save();
    if (reached.by_hand) {
      // lo que haría una persona: actualizar a mano, y abrir una sesión más
      const hand = seen(TL.harness(tree, ['update', '--yes'], { env: sessionEnv, cwd: home }), '«harness.js update --yes», a mano');
      facts.by_hand = { exit: hand.exit, error: hand.error, version: TL.installedVersion(tree), said: L.clip(TL.lastLines(`${hand.stdout}\n${hand.stderr}`, 3), 400) };
      if (forms['default-shell']) sessions.push(Object.assign(open(forms, 'default-shell', 'después-a-mano', sessionEnv), { by_hand: true }));
    }
    facts.after = RP.photo({ home, tree, env: sessionEnv, paths, platform, scratch: scratchPieces });
    // la lista de piezas, antes y después, y lo que dice la máquina cuando saca las de un paquete
    // (la misma línea puede aparecer en el registro y en el aviso de la sesión siguiente: se cuentan las distintas, cada
    // una sin lo que la rodea en su renglón)
    // (el registro recorta los renglones largos: la misma línea, cortada, no es otra — se identifica por su comienzo, con
    // qué paquetes y qué piezas)
    const keyOf = (l) => { const m = /(?:se sacaron|sacaría) \d+ pieza\(s\) de paquete\(s\) que la organización no activa \([^)]*\)/.exec(l); return m ? m[0] : null; };
    const found = sessions.flatMap((x) => [...linesOf(x), ...(x.log_lines || [])]).flatMap((l) => l.split(' · ')).filter((l) => PACK_LINE.test(l));
    const said = [...new Set(found.map(keyOf).filter(Boolean))];
    // el texto que se muestra es la copia ENTERA (la que llega hasta dónde se activa), no una recortada por el registro
    const full = found.map((l) => l.replace(/^[\s\S]*?(se sacaron|sacaría)/, '$1').trim()).filter((l) => !/[\r\n]/.test(l)).sort((a, b) => Number(/activalo/.test(b)) - Number(/activalo/.test(a)) || b.length - a.length);
    facts.pack_line = { count: said.length, text: full[0] ? L.clip(full[0], 600) : null };
    facts.pieces = judgePieces({ before: facts.before.pieces, after: facts.after.pieces, renames: PZ.renamesOf(tree), packActive: v.team === true, packLine: facts.pack_line });
    for (const f of facts.pieces.findings) add(f);
    delete facts.pieces.findings;
    facts.after_smoke = T.smoke({ settingsFile: settings, forms: smokeForms, home, scratch, env: sessionEnv, platform });
    try { if (facts.after.settings.exists && !facts.after.settings.problem) L.writeJsonAtomic(path.join(out, `settings-update-${v.id}-after.json`), ctx.redact(T.readJsonLoose(settings).value)); } catch (_) { /* la copia es de cortesía */ }
    // la máquina que no tenía la carpeta global de hooks la tiene, con el pre-push del arnés adentro, sin que nadie corra nada
    facts.hooks_path_after = hooksPathFacts(home, sessionEnv);
    if (!facts.hooks_path_after.same || !facts.hooks_path_after.pre_push) add({ id: 'pre-push-not-active', kind: 'git-hooks', severity: T.SEVERITY.loses, detail: `después de las sesiones, core.hooksPath global es «${facts.hooks_path_after.value || 'nada'}» (se esperaba ${facts.hooks_path_after.expected}) y el pre-push del arnés ${facts.hooks_path_after.pre_push ? 'está' : 'NO está'} ahí: el freno antes de publicar no corre` });
    facts.differences = RP.comparePhotos(facts.before, facts.after, { sessions, smokeBefore: facts.before_smoke, smokeAfter: facts.after_smoke, expectVersion: next });
    for (const d of facts.differences) add(d);
    facts.answers = RP.answers(facts.before, facts.after, facts.differences, { sessions, expectVersion: next });
    const told = [facts.after.state && facts.after.state.notice, ...sessions.flatMap(toldBy), ...sessions.flatMap((s) => s.log_lines || [])].filter(Boolean).filter((l) => /versi[oó]n|actualiz/i.test(l));
    facts.answers.what_the_dev_is_told = [...new Set(told)].slice(0, 6).map((l) => L.clip(l, 300));
    facts.answers.by_severity = bySeverity();
    say(`update: ${v.id} — quedó en ${facts.version_after || 'una versión que no se pudo leer'}${facts.updated_by_itself === null ? ' (no se sabe si llegó sola)' : (facts.updated_by_itself ? ' sola' : ' (NO lo hizo sola)')} · rompe ${facts.answers.by_severity.breaks} · pierde un control ${facts.answers.by_severity['loses-control']} · ruido ${facts.answers.by_severity.noise}`);
  } else if (v.id === 'ask') {
    const sessions = [open(forms, 'default-shell', 'una', sessionEnv), open(forms, 'default-shell', 'otra', sessionEnv)];
    facts.sessions = sessions;
    judgeSessions(sessions);
    facts.version_after = versionNow('después de las dos sesiones');
    if (!facts.version_after) return cannotTell();
    facts.changed_by_itself = facts.version_after !== facts.version_before;
    save();
    // (un estado que está y no se deja leer TIRA: no es «no hay aviso», es no poder saberlo)
    const st = TL.stateOf(paths);
    const judged = judgeAsk({ state_notice: st && st.notice ? st.notice : null, sessions, published: next, before: facts.version_before, after: facts.version_after });
    facts.what_the_dev_is_told = judged.what_the_dev_is_told;
    for (const f of judged.findings) add(f);
    // «a mano», pero sin una terminal (el ensayo no tiene una persona delante): el programa tiene que negarse y la
    // máquina no cambia. Aplicarla de verdad, con una persona en una terminal, está en lo no ensayado
    const before = facts.version_after;
    const hand = seen(TL.harness(tree, ['update', '--yes'], { env: sessionEnv, cwd: home }), '«harness.js update --yes», sin una terminal');
    const said = L.clip(TL.lastLines(`${hand.stdout}\n${hand.stderr}`, 3), 400);
    const afterHand = versionNow('después de «harness.js update --yes» sin una terminal');
    // (sin número no se juzga si se negó limpio: `refused_cleanly` queda nulo, y el reporte dice «no se juzgó»)
    if (!afterHand) { facts.by_hand = { without_a_terminal: true, exit: hand.exit, error: hand.error, version: null, said, refused_cleanly: null }; return cannotTell(); }
    const tried = judgeByHand({ exit: hand.exit, error: hand.error, said, version_before: before, version_after: afterHand });
    facts.by_hand = { without_a_terminal: true, exit: hand.exit, error: hand.error, version: afterHand, said, refused_cleanly: tried.refused_cleanly };
    for (const f of tried.findings) add(f);
    // (sin hallazgo y sin haberse negado limpio: queda dicho en el reporte, en la fila de «a mano»)
    facts.answers = { by_severity: bySeverity() };
    const noticed = !judged.findings.some((f) => f.id === 'update:ask:no-notice' || f.id === 'update:ask:applied-by-itself');
    say(`update: ${v.id} — ${facts.changed_by_itself ? 'CAMBIÓ sola de versión' : 'no cambió de versión'}; aviso de la versión nueva en el estado: ${noticed ? 'sí' : 'NO'}; dicho por un hook: ${facts.what_the_dev_is_told.hook_said ? 'sí' : 'NO'}; a mano sin terminal: ${tried.refused_cleanly ? 'se negó y lo dijo' : `salió ${hand.error || hand.exit}, versión ${facts.by_hand.version}`}`);
  } else {
    // sin pwsh: el mismo ambiente, con pwsh fuera del PATH
    const after = Object.assign({}, sessionEnv, { [L.pathKey(sessionEnv)]: bare.env[L.pathKey(bare.env)] });
    const formsAfter = T.launchForms({ env: after, platform, scratch });
    const sessions = [['sin-pwsh-1', 'bash-c'], ['sin-pwsh-2', 'default-shell']].filter(([, formId]) => formsAfter[formId]).map(([label, formId]) => open(formsAfter, formId, label, after));
    facts.sessions = sessions;
    // acá que la línea de arranque falle es lo que se mide, con su propio hallazgo: del juicio común queda lo demás
    judgeSessions(sessions, '', { startup: false });
    missingForms(formsAfter, ['bash-c', 'default-shell']);
    facts.version_after = versionNow('después de las sesiones sin pwsh');
    if (!facts.version_after) return cannotTell();
    facts.updated = facts.version_after ? facts.version_after === next : null;
    save();
    const doctor = T.doctorFacts(path.join(tree, 'scripts', 'setup', 'harness.js'), after, home);
    const judged = judgePwshMissing({ updated: facts.updated, sessions, doctor });
    facts.startup_hooks = judged.startup_hooks;
    facts.something_tells = judged.something_tells;
    facts.doctor = { readable: doctor.readable, fail: doctor.fail || null, warn: doctor.warn || null };
    for (const f of judged.findings) add(f);
    facts.answers = { by_severity: bySeverity() };
    say(`update: ${v.id} — ${facts.updated ? 'se actualizó igual' : 'NO se actualizó'}; algo le avisa a la persona: ${facts.something_tells.hook || facts.something_tells.doctor ? 'sí' : 'NO'}`);
  }
  save();
  return true;
}

/** La actualización sobre una máquina instalada con la página, sobre una copia publicada. `state`: el del laboratorio. */
function measure({ lab, out, state, platform = process.platform, baseEnv = process.env, allowTemp = false, only = null, rec, waitCapMs = TL.WAIT_CAP_MS, waitBudgetMs = TL.VARIANT_WAIT_BUDGET_MS }) {
  const choice = TL.chooseVariants(VARIANTS, only);
  if (choice.problem) return GI.notReady(choice.problem);
  const say = (s) => process.stdout.write(`${s}\n`);
  const genv = TL.gitEnv(lab, { base: baseEnv, platform });
  const harness = state.remotes.harness;
  return TL.onRehearsedCommit(state, genv, () => {
    const ctx = GI.openLab({ lab, name: NAME, state, baseEnv, platform });
    if (ctx.problem) return GI.notReady(ctx.problem);
    // la página instala con la línea npx: el paquete del commit que se ensaya
    const pk = GI.packageFor(ctx, state);
    if (pk.problem) return GI.notReady(ctx.discard(pk.problem));
    ctx.package = pk.tgz;
    const watch = TL.watching(ctx.redact, ctx.tokens);
    rec.setRedactor(watch.redact);
    try {
      GI.noteLab(rec, ctx, state, platform);
      rec.fact('same_machine_note', SAME_MACHINE_NOTE);
      // la copia «autor», con la que se publican las versiones de juguete sobre lo que se ensaya
      const author = path.join(ctx.dir, 'author');
      const cloned = TL.git(ctx.dir, ['clone', '--quiet', harness.dir, author], ctx.genv);
      // (el laboratorio del paso no se terminó de armar: se saca su carpeta, para que el paso se pueda reintentar)
      if (cloned.error || cloned.exit !== 0) return GI.notReady(ctx.discard(`no pude clonar el remoto del laboratorio para publicar las versiones de juguete (git clone salió ${cloned.error || cloned.exit}: ${L.firstLine(cloned.stderr)})`));
      const rehearsed = rec.step.facts.rehearsed_version || null;
      let published = 0;
      // `stage`: la versión de antes de la mudanza de juguete o la de después
      const publishNext = (stage) => {
        const number = TL.nextVersion(rehearsed, ++published);
        const p = TL.publish({ author, number, env: ctx.genv, extra: moveChanges(stage) });
        if (!p.ok) throw new Error(`no pude publicar la versión de juguete ${number}: ${p.reason}`);
        return number;
      };
      const result = TL.runVariants({ variants: choice.chosen, rec, say, run: (v, facts, save) => {
        const add = (d, prefix = '') => rec.finding(`${NAME}:${v.id}:${prefix}${d.id}`, d.kind, d.detail, null, { severity: d.severity, variant: v.id });
        return runVariant({ ctx, v, facts, save, lab, out, platform, allowTemp, baseEnv, rec, add, say, publishNext, waitCapMs, waitBudgetMs });
      } });
      // la red de abajo: un permiso de juguete en algo que se iba a guardar sin haber pasado por la revisión en crudo
      for (const f of TL.savedLeaks(watch)) rec.finding(`${NAME}:${f.id}`, f.kind, f.detail, null, { severity: f.severity });
      return TL.variantsStatus(result, choice.chosen);
    } finally { ctx.stop(); }
  });
}

module.exports = { NAME, VARIANTS, SESSIONS, INSTALL_STEPS, SAME_MACHINE_NOTE, MOVED, PACK_LINE, SETTINGS_TEMP, moveChanges, judgePieces, judgeAsk, judgeByHand, judgePwshMissing, judgeInstalled, judgeVersionRead, judgeReached, judgeTwoSessions, measure };
