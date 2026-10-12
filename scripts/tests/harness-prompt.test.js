'use strict';
/**
 * harness-prompt.test.js — la pregunta del programa de instalación (`scripts/setup/harness/prompt.js`; story 8.16,
 * tanda B · AC 2 · T13).
 *
 * Lo que no se puede perder:
 *   · «hay terminal» es `process.stdin.isTTY` y nada más (lo mismo que `uninstall` desde la 8.13);
 *   · un sí acepta `s`, `si`, `sí`, `y`, `yes` (mayúsculas y espacios alrededor); CUALQUIER otra cosa es no: vacío,
 *     fin de entrada, una lectura que tira (terminal cerrada), `n`, una palabra que empieza con s;
 *   · sin terminal no se imprime ninguna pregunta y la respuesta es no; con terminal se imprime una vez y se lee una
 *     línea, sin tiempo límite ni colores.
 *
 * 🔴 rojo previo verificado: sin `scripts/setup/harness/prompt.js` todo falla en el `require`.
 * 🔴 No lee la terminal de verdad: la lectura se inyecta.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..', '..');
const P = require(path.join(RAIZ, 'scripts', 'setup', 'harness', 'prompt.js'));

/** Un `readSync` de mentira que entrega `chunks` de a uno y después fin de entrada (0). */
function fakeReadSync(chunks) {
  const queue = chunks.map((c) => Buffer.from(c, 'utf8'));
  return (fd, buf) => {
    const next = queue.shift();
    if (!next) return 0;
    next.copy(buf, 0, 0, Math.min(next.length, buf.length));
    return Math.min(next.length, buf.length);
  };
}

test('T13 · Prompt_OnlyIsTTY_ClosedAnswers_EofIsNo', async (t) => {
  await t.test('un sí: s, SI, « sí », yes, Y', () => {
    for (const a of ['s', 'SI', ' sí ', 'yes', 'Y', 'Sí', 'si\r']) assert.strictEqual(P.saidYes(a), true, `«${a}» es sí`);
  });
  await t.test('todo lo demás es no: vacío, n, no, una palabra que empieza con s, null', () => {
    for (const a of ['', '   ', 'n', 'no', 'N', 'sip', 'siempre', 'yess', 'ok', null, undefined]) {
      assert.strictEqual(P.saidYes(a), false, `«${a}» es no`);
    }
  });
  await t.test('readLine: lee hasta el salto de línea, aunque llegue en pedazos', () => {
    assert.strictEqual(P.readLine({ readSync: fakeReadSync(['s', 'i\nresto']) }), 'si');
  });
  await t.test('readLine: una terminal sin nada escrito todavía (EAGAIN) se espera, sin tiempo límite', () => {
    // la persona tipea DESPUÉS de ver la pregunta: Node deja la terminal sin bloqueo y la lectura dice EAGAIN hasta que hay
    // algo. Tomarlo como «no» hacía que nadie pudiera contestar a tiempo (lo encontró T21 con la respuesta demorada)
    let calls = 0;
    const late = (fd, buf) => {
      calls++;
      if (calls <= 3) throw Object.assign(new Error('EAGAIN: resource temporarily unavailable, read'), { code: 'EAGAIN' });
      return Buffer.from('s\n').copy(buf);
    };
    assert.strictEqual(P.readLine({ readSync: late }), 's');
    assert.ok(calls > 3);
  });
  await t.test('readLine: un «sí» con la í partida entre dos lecturas sigue siendo sí', () => {
    const bytes = Buffer.from('sí\n', 'utf8');   // s · 0xC3 0xAD · \n
    const split = [bytes.subarray(0, 2), bytes.subarray(2)];
    const r = P.readLine({ readSync: (fd, buf) => { const c = split.shift(); if (!c) return 0; c.copy(buf); return c.length; } });
    assert.strictEqual(r, 'sí');
    assert.strictEqual(P.saidYes(r), true);
  });
  await t.test('readLine: fin de entrada sin nada es vacío; una lectura que tira, también', () => {
    assert.strictEqual(P.readLine({ readSync: fakeReadSync([]) }), '');
    assert.strictEqual(P.readLine({ readSync: () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); } }), '');
  });
  await t.test('isTerminal: sólo isTTY === true', () => {
    assert.strictEqual(P.isTerminal({ isTTY: true }), true);
    for (const s of [{ isTTY: false }, {}, { isTTY: 1 }, null]) assert.strictEqual(P.isTerminal(s), false);
  });
  await t.test('ask sin terminal: no imprime nada, no lee y contesta no', () => {
    const written = [];
    let read = 0;
    const r = P.ask('¿Instalo? [s/N] ', { tty: false, write: (s) => written.push(s), read: () => { read++; return 's'; } });
    assert.strictEqual(r, false);
    assert.deepStrictEqual(written, []);
    assert.strictEqual(read, 0);
  });
  await t.test('ask con terminal: imprime la pregunta una vez y lee una línea', () => {
    for (const [answer, want] of [['s', true], ['', false], ['n', false]]) {
      const written = [];
      const r = P.ask('¿Instalo? [s/N] ', { tty: true, write: (s) => written.push(s), read: () => answer });
      assert.strictEqual(r, want, `respuesta «${answer}»`);
      assert.deepStrictEqual(written, ['¿Instalo? [s/N] ']);
    }
  });
  await t.test('ask con terminal y fin de entrada (lectura vacía): no', () => {
    assert.strictEqual(P.ask('¿Aplico ahora? [s/N] ', { tty: true, write: () => {}, read: () => P.readLine({ readSync: fakeReadSync([]) }) }), false);
  });
});

// ── story 8.16, tanda D (AC 30, 31 y 37 · T52 y las piezas de las preguntas) ────────────────────────────────────────
// Las preguntas de la instalación (scripts/setup/harness/questions.js) usan la misma lectura: `readAnswer` dice además si
// la entrada se terminó, porque en una terminal la lectura que sigue a un fin de entrada vuelve a esperar y una pregunta
// que se repite se quedaría esperando sin que nadie conteste.
// 🔴 rojo previo verificado: antes de la tanda D no existían `readAnswer` ni questions.js (todo falla en el require).
const fs = require('fs');
const { spawnSync } = require('child_process');
const Q = require(path.join(RAIZ, 'scripts', 'setup', 'harness', 'questions.js'));

/** Una lectura de mentira que entrega `answers` de a una ({ text, eof }) y después fin de entrada. */
function answersOf(answers) {
  const queue = [...answers];
  return () => (queue.length ? { text: queue.shift(), eof: false } : { text: '', eof: true });
}

test('8.16 D · readAnswer: una línea, o fin de entrada dicho como tal', () => {
  assert.deepStrictEqual(P.readAnswer({ readSync: fakeReadSync(['minimal\n']) }), { text: 'minimal', eof: false });
  assert.deepStrictEqual(P.readAnswer({ readSync: fakeReadSync(['\n']) }), { text: '', eof: false }, 'Enter no es fin de entrada');
  assert.deepStrictEqual(P.readAnswer({ readSync: fakeReadSync([]) }), { text: '', eof: true });
  const closed = () => { const e = new Error('EIO'); e.code = 'EIO'; throw e; };
  // desde la tanda G de la 8.23 la lectura que TIRA además dice cuál fue el error (`error`): quien lee por tubería
  // distingue «no escribieron nada» de «no pude leer» (antes los dos salían como «llegó vacío»)
  assert.deepStrictEqual(P.readAnswer({ readSync: closed }), { text: '', eof: true, error: 'EIO' }, 'una terminal cerrada es fin de entrada, con su error');
  assert.strictEqual(P.readLine({ readSync: fakeReadSync(['s\r\n']) }), 's', 'readLine sigue devolviendo el texto');
});

test('8.16 D · askProfile: sin valor por defecto, tres intentos, fin de entrada corta', async (t) => {
  const effects = [
    { kind: 'hook', when: 'always', blocks: 'no', profiles: ['minimal', 'full'] },
    { kind: 'hook', when: 'optin:TYCON_SAFETY_GUARD', blocks: 'any-repo', profiles: ['minimal', 'full'] },
    { kind: 'hook', when: 'always', blocks: 'harness-repos', profiles: ['full'] },
    { kind: 'block', when: 'always', blocks: 'no', profiles: ['full'] },
  ];
  await t.test('Enter, Enter, 2 → full; 1 → minimal; «MINIMAL » vale', () => {
    assert.strictEqual(Q.askProfile({ effects, read: answersOf(['', '', '2']), write: () => {} }).value, 'full');
    assert.strictEqual(Q.askProfile({ effects, read: answersOf(['1']), write: () => {} }).value, 'minimal');
    assert.strictEqual(Q.askProfile({ effects, read: answersOf([' MINIMAL ']), write: () => {} }).value, 'minimal');
  });
  await t.test('tres vacías o inválidas → sin perfil; fin de entrada → sin perfil y sin seguir leyendo', () => {
    assert.strictEqual(Q.askProfile({ effects, read: answersOf(['', '', '']), write: () => {} }).value, null);
    assert.strictEqual(Q.askProfile({ effects, read: answersOf(['3', 'medio', 'tres', 'full']), write: () => {} }).value, null, 'a la tercera inválida no hay cuarta');
    let reads = 0;
    const r = Q.askProfile({ effects, read: () => { reads++; return { text: '', eof: true }; }, write: () => {} });
    assert.deepStrictEqual([r.value, r.eof, reads], [null, true, 1]);
  });
  await t.test('los dos renglones de cada perfil salen de la lista', () => {
    const L = Q.profileLines(effects);
    assert.strictEqual(L.length, 4);
    assert.match(L[0], /^ {2}1\) minimal: 2 hooks \(1 puede frenar un comando\)/);
    assert.match(L[2], /^ {2}2\) full: 3 hooks \(2 pueden frenar un comando\)/);
    assert.match(L[1], /no cambia cómo contesta el asistente/);
    assert.match(L[3], /1 bloque de reglas que cambian cómo contesta el asistente/);
  });
});

test('8.16 D · askIntegrations y las opciones: sólo lo ofrecido, nada marcado', () => {
  const offered = [{ key: 'clockify', does: 'a', needs: 'b' }, { key: 'engram', does: 'c', needs: 'd' }];
  assert.deepStrictEqual(Q.askIntegrations({ offered, read: answersOf(['']), write: () => {} }).names, [], 'Enter es ninguna');
  assert.deepStrictEqual(Q.askIntegrations({ offered, read: answersOf(['Engram , clockify,engram']), write: () => {} }).names, ['engram', 'clockify']);
  const said = [];
  assert.deepStrictEqual(Q.askIntegrations({ offered, read: answersOf(['mailbox', 'engram']), write: (s) => said.push(s) }).names, ['engram']);
  assert.ok(said.some((s) => s.includes('«mailbox» no es una de las que se ofrecen (clockify, engram)')), said.join(''));
  assert.strictEqual(Q.askIntegrations({ offered, read: answersOf(['x', 'y', 'z']), write: () => {} }).names, null);
  assert.deepStrictEqual(Q.askIntegrations({ offered, read: answersOf([]), write: () => {} }), { names: [], eof: true });
  assert.deepStrictEqual(Q.checkIntegrationsOption('none', ['clockify', 'engram']), { names: [] });
  assert.match(Q.checkIntegrationsOption('foo', ['clockify', 'engram']).error, /válidas: clockify, engram, o none/);
  assert.deepStrictEqual(Q.checkPacksOption('all'), { value: 'all' });
  assert.match(Q.checkPacksOption('medio').error, /all o none/);
  assert.strictEqual(Q.checkPacksOption(undefined), null);
});

// T52 · Questions_SameCodeOnEveryPlatform_Ps1Untouched (AC 37): las preguntas son el mismo código en cualquier sistema
// —ninguna rama por plataforma en prompt.js, questions.js ni en las funciones de harness.js que preguntan— y la tanda no
// tocó el instalador de Windows ni su sync de bloques.
test('T52 · Questions_SameCodeOnEveryPlatform_Ps1Untouched', async (t) => {
  const PLATFORM = /platform|win32|isWin\(|darwin/;
  await t.test('prompt.js y questions.js no miran la plataforma', () => {
    for (const f of ['prompt.js', 'questions.js']) {
      const code = fs.readFileSync(path.join(RAIZ, 'scripts', 'setup', 'harness', f), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join('\n');
      assert.ok(!PLATFORM.test(code), `${f} mira la plataforma: ${(code.match(PLATFORM) || [])[0]}`);
    }
  });
  await t.test('las funciones de harness.js que preguntan tampoco', () => {
    const src = fs.readFileSync(path.join(RAIZ, 'scripts', 'setup', 'harness.js'), 'utf8');
    for (const fn of ['installQuestions', 'writeAnswers', 'askLaterNote']) {
      const start = src.indexOf(`function ${fn}(`);
      assert.ok(start >= 0, `harness.js no tiene ${fn}`);
      const end = src.indexOf('\n}\n', start);
      const body = src.slice(start, end).split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
      assert.ok(!PLATFORM.test(body), `${fn} mira la plataforma: ${(body.match(PLATFORM) || [])[0]}`);
    }
  });
  await t.test('la tanda D no tocó el instalador de Windows ni su sync de bloques', (tt) => {
    const git = (args) => spawnSync('git', ['-C', RAIZ, ...args], { encoding: 'utf8' });
    const files = ['scripts/install-tycon-hooks.ps1', 'scripts/setup/sync-claude-md-blocks.ps1'];
    // el commit que trajo esta prueba de la tanda D (si todavía no está commiteada, se compara el árbol con HEAD)
    const log = git(['log', '--diff-filter=A', '--format=%H', '--', 'scripts/tests/harness-questions.test.sh']);
    if (log.status !== 0) { tt.skip(`NO MEDIDO: git log salió ${log.status} (${(log.stderr || '').trim()})`); return; }
    const added = log.stdout.trim().split('\n').filter(Boolean).pop();
    const diff = added ? git(['diff', '--quiet', `${added}^`, added, '--', ...files]) : git(['diff', '--quiet', 'HEAD', '--', ...files]);
    if (diff.status !== 0 && diff.status !== 1) { tt.skip(`NO MEDIDO: git diff salió ${diff.status} (${(diff.stderr || '').trim()})`); return; }
    assert.strictEqual(diff.status, 0, `la tanda D cambió ${files.join(' o ')}`);
  });
});

// T46 (story 8.23, tanda G · AC 43): el valor secreto se lee de la terminal SIN eco y sin la basura del pegado. En la
// primera máquina migrada (2026-10-08) `config set github.token` mostró la clave y guardó las marcas del pegado (401).
test('T46 · ReadSecret_NoEcho_BracketedPasteStripped_BackspaceCtrlC', async (t) => {
  const bytes = (...parts) => parts.map((p) => Buffer.isBuffer(p) ? p : Buffer.from(p, 'utf8'));
  const tty = () => { const calls = []; return { isTTY: true, setRawMode(v) { calls.push(v); }, calls }; };
  const read = (chunks) => { const q = bytes(...chunks); return (fd, buf) => { const n = q.shift(); if (!n) return 0; n.copy(buf, 0, 0, Math.min(n.length, buf.length)); return Math.min(n.length, buf.length); }; };
  await t.test('Enter termina (CR o LF); el valor no se escribe en la salida; el modo crudo se prende y se apaga', () => {
    const written = []; const s = tty();
    const r = P.readSecret({ stdin: s, readSync: read(['abc', '\r']), write: (x) => written.push(x) });
    assert.deepStrictEqual(r, { text: 'abc', aborted: false, echoed: false });
    assert.ok(!written.join('').includes('abc'), `el valor no sale por la terminal: ${JSON.stringify(written)}`);
    assert.deepStrictEqual(s.calls, [true, false]);
    assert.strictEqual(P.readSecret({ stdin: tty(), readSync: read(['xyz\n']), write: () => {} }).text, 'xyz');
  });
  await t.test('un pegado con marcas (ESC[200~ … ESC[201~) y otras secuencias de control se descartan', () => {
    const r = P.readSecret({ stdin: tty(), readSync: read(['\x1b[200~', 'ghp_', 'tok', '\x1b[201~', '\x1b[A', '\r']), write: () => {} });
    assert.strictEqual(r.text, 'ghp_tok');
    // las marcas enteras en un solo pedazo, y un salto de línea pegado adentro del valor NO termina la lectura si viene dentro del pegado
    assert.strictEqual(P.readSecret({ stdin: tty(), readSync: read(['\x1b[200~ab\ncd\x1b[201~\n']), write: () => {} }).text, 'abcd');
  });
  await t.test('Backspace borra; un carácter de varios bytes partido entre lecturas no se rompe; los controles sueltos no entran', () => {
    assert.strictEqual(P.readSecret({ stdin: tty(), readSync: read(['ab', '\x7f', 'c', '\x08', 'd\r']), write: () => {} }).text, 'ad');
    const b = Buffer.from('ñ', 'utf8');
    assert.strictEqual(P.readSecret({ stdin: tty(), readSync: read([b.subarray(0, 1), b.subarray(1), '\t\x01x\n']), write: () => {} }).text, 'ñx');
    // Backspace sobre un carácter de varios bytes lo borra ENTERO (pase adversarial de la tanda G: quedaba el primer byte → U+FFFD)
    assert.strictEqual(P.readSecret({ stdin: tty(), readSync: read(['añ', '\x7f', '\r']), write: () => {} }).text, 'a');
    assert.strictEqual(P.readSecret({ stdin: tty(), readSync: read(['a€b', '\x7f\x7f', 'c\r']), write: () => {} }).text, 'ac');
  });
  await t.test('Ctrl-C y Ctrl-D abortan sin devolver nada; el modo crudo se apaga igual', () => {
    const s = tty();
    assert.deepStrictEqual(P.readSecret({ stdin: s, readSync: read(['ab', '\x03']), write: () => {} }), { text: '', aborted: true, echoed: false });
    assert.deepStrictEqual(s.calls, [true, false]);
    assert.strictEqual(P.readSecret({ stdin: tty(), readSync: read(['\x04']), write: () => {} }).aborted, true);
    assert.strictEqual(P.readSecret({ stdin: tty(), readSync: read([]), write: () => {} }).aborted, true, 'fin de entrada sin Enter: abortado');
  });
  await t.test('un Esc suelto, una flecha ESC O A o Alt+tecla NO dejan la lectura colgada: se descartan y Enter sigue valiendo', () => {
    // el cazador de fallos silenciosos (tanda G) lo armó a mano: ESC seguido de texto esperaba el cierre de una secuencia
    // que no venía, y ni Enter ni Ctrl-C salían (el modo crudo apaga el Ctrl-C del sistema)
    assert.strictEqual(P.readSecret({ stdin: tty(), readSync: read(['\x1b', 'abc\r']), write: () => {} }).text, 'abc');
    assert.strictEqual(P.readSecret({ stdin: tty(), readSync: read(['\x1bOA', 'x\r']), write: () => {} }).text, 'x');
    assert.strictEqual(P.readSecret({ stdin: tty(), readSync: read(['\x1bq', 'y\n']), write: () => {} }).text, 'y');
    assert.strictEqual(P.readSecret({ stdin: tty(), readSync: read(['\x1b[', '200~tok\x1b[201~\r']), write: () => {} }).text, 'tok', 'una marca de pegado cortada en dos lecturas se completa');
    assert.strictEqual(P.readSecret({ stdin: tty(), readSync: read(['\x1b[zq', 'w\r']), write: () => {} }).text, 'qw', 'ESC [ z es una secuencia CSI entera (z es un byte final válido): se descarta y el texto sigue');
    assert.strictEqual(P.readSecret({ stdin: tty(), readSync: read(['\x1b[é', 'w\r']), write: () => {} }).text, 'éw', 'ESC [ seguido de algo que no es una secuencia: se descartan esos dos bytes y el texto sigue');
    assert.deepStrictEqual(P.readSecret({ stdin: tty(), readSync: read(['ab\x1b', '\x03']), write: () => {} }).aborted, true, 'Ctrl-C después de un Esc suelto sigue abortando');
    // una «secuencia» CSI de más de 32 bytes no es una secuencia: se descartan ESC [ y el resto cuenta como texto. Sin el
    // tope quedaría pendiente y la «A» siguiente la cerraría como secuencia, comiéndose los 40 dígitos y la A
    assert.strictEqual(P.readSecret({ stdin: tty(), readSync: read([`\x1b[${'1'.repeat(40)}`, 'A\r']), write: () => {} }).text, `${'1'.repeat(40)}A`);
    // ESC O cortada entre dos lecturas: se completa con la tecla que sigue y se descarta entera
    assert.strictEqual(P.readSecret({ stdin: tty(), readSync: read(['\x1bO', 'Ax\r']), write: () => {} }).text, 'x');
    // EAGAIN en modo crudo (la persona todavía no tipeó) se espera, como en readAnswer
    let calls = 0;
    const late = (fd, buf) => { calls++; if (calls <= 3) throw Object.assign(new Error('EAGAIN'), { code: 'EAGAIN' }); return Buffer.from(calls === 4 ? 'z' : '\r').copy(buf); };
    assert.strictEqual(P.readSecret({ stdin: tty(), readSync: late, write: () => {}, wait: () => {} }).text, 'z');
  });
  await t.test('un error de lectura real (EIO) no es «cancelado»: viene con `error`; readAnswer también lo dice', () => {
    const eio = () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); };
    const r = P.readSecret({ stdin: tty(), readSync: eio, write: () => {} });
    assert.strictEqual(r.aborted, true); assert.strictEqual(r.error, 'EIO');
    assert.strictEqual(P.readSecret({ stdin: tty(), readSync: read(['\x04']), write: () => {} }).error, undefined, 'Ctrl-D es cancelar, no un error');
    const a = P.readAnswer({ readSync: eio });
    assert.deepStrictEqual(a, { text: '', eof: true, error: 'EIO' });
    assert.strictEqual(P.readAnswer({ readSync: read([]) }).error, undefined, 'fin de entrada sin nada no es un error');
  });
  await t.test('sin modo crudo (una terminal que no lo tiene) se lee con eco y se dice (echoed: true)', () => {
    const r = P.readSecret({ stdin: { isTTY: true }, readSync: read(['abc\n']), write: () => {} });
    assert.deepStrictEqual(r, { text: 'abc', aborted: false, echoed: true });
  });
  await t.test('readAnswer sobre una tubería con el escritor vivo (EAGAIN y después datos sin salto): lee hasta el fin', () => {
    let calls = 0;
    const late = (fd, buf) => { calls++; if (calls <= 2) throw Object.assign(new Error('EAGAIN'), { code: 'EAGAIN' }); if (calls === 3) return Buffer.from('tok-sin-salto').copy(buf); return 0; };
    assert.deepStrictEqual(P.readAnswer({ readSync: late }), { text: 'tok-sin-salto', eof: false });
  });
});
