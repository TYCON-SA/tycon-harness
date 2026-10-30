'use strict';
// El estado de una historia y el marcador de la ejecución no se tocan a mano (@story-8.109).
//
// Un modelo al que el freno de seguridad le negó cerrar una ejecución en rojo pasó la historia a `done` con un `node -e`
// y borró el marcador con `rm`. Tres frenos lo cierran:
// - la puerta de consola no deja escribir una historia que no está en borrador (se edita con la herramienta de edición);
// - el gancho del encabezado no deja pasar una historia a `review` o `done` a mano sin «autorizo cambiar el estado»;
// - la puerta de consola no deja borrar ni mover los marcadores (`active/`, `active.json`).
//
// Los ganchos corren como los corre Claude Code: un proceso aparte, el evento por la entrada, una HOME, un repo y una
// conversación de juguete. Los comandos van en las tablas de abajo, no en la línea de un comando: el portón de esta
// máquina los frenaría.
// Correr: node --test skills/tycon-pipeline/scripts/tests/status-by-hand.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const RAIZ = path.join(SCRIPTS, '..', '..', '..');
const PUERTA = path.join(SCRIPTS, 'on-bash-write-gate.js');
const ENCABEZADO = path.join(SCRIPTS, 'on-frontmatter-write.js');
const PRE_EDIT = path.join(SCRIPTS, 'hook-pre-edit.js');
const SID = 's-8109';
const TUID = 'toolu_8109';
const HISTORIA = 'specs/story-9.9-algo.md';

// stable-data: la ventana de 30 minutos de la frase se mide contra el reloj real; la conversación queda cerca de él
const hace = (min) => new Date(Date.now() - min * 60000).toISOString();
const deLaPersona = (texto, min = 2) => ({ type: 'user', timestamp: hace(min), message: { role: 'user', content: texto } });

/**
 * Una HOME con un repo, una historia en `status`, el marcador abierto de la sesión y la conversación (null = sin
 * registro, como Codex) con el pedido que se juzga al final.
 */
function nuevaHome({ status = 'in-progress', conversacion = [deLaPersona('seguí')], herramienta = 'Bash', extra = '' } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'status-by-hand-'));
  const repo = path.join(home, 'repo');
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  spawnSync('git', ['init', '-q', repo]);
  const historia = path.join(repo, HISTORIA);
  fs.writeFileSync(historia, `---\nepic: 9\nstory: "9.9"\ntitle: "Algo"\nstatus: ${status}\n${extra}qa_guide: off\n---\n\n# Story 9.9\n\nStatus: ${status}\n\n## Story\n\nTexto.\n`);
  fs.writeFileSync(path.join(repo, 'specs', 'otra.md'), '# otra\n');
  fs.writeFileSync(path.join(repo, 'notas.md'), '# notas\n');
  const activos = path.join(home, '.claude', '.tycon-pipeline', 'active');
  fs.mkdirSync(activos, { recursive: true });
  const marcador = { storyId: '9.9', storyPath: historia, repoPath: repo, startedAt: hace(60),
    stepsPending: ['reviewers', 'prepare-commit'], stepsCompleted: ['start', 'implement'] };
  fs.writeFileSync(path.join(activos, `${SID}.json`), JSON.stringify(marcador));
  fs.writeFileSync(path.join(activos, 'otra-sesion.json'), JSON.stringify({ ...marcador, storyId: '9.8' }));
  if (conversacion) {
    const dir = path.join(home, '.claude', 'projects', '-repo');
    fs.mkdirSync(dir, { recursive: true });
    let padre = null;
    const out = conversacion.map((r, i) => { const u = `u-${i}`; const x = { ...r, uuid: u, parentUuid: padre }; padre = u; return x; });
    out.push({ type: 'assistant', timestamp: hace(0), uuid: 'u-pedido', parentUuid: padre,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: TUID, name: herramienta, input: {} }] } });
    fs.writeFileSync(path.join(dir, `${SID}.jsonl`), out.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
  return { home, repo, historia, estado: path.join(home, '.claude', '.tycon-pipeline') };
}

function correr(gancho, h, evento, env = {}) {
  const e = { ...process.env, HOME: h.home, USERPROFILE: h.home };
  for (const k of Object.keys(e)) if (/^TYCON_|^CLAUDE_CODE_SESSION_ID$/.test(k)) delete e[k];
  // las bibliotecas del arnés son las de este árbol (en la HOME de juguete no hay arnés instalado)
  e.TYCON_GUIDES_DIR = RAIZ;
  Object.assign(e, env);
  const r = spawnSync(process.execPath, [gancho], {
    input: JSON.stringify({ session_id: SID, tool_use_id: TUID, cwd: h.repo, ...evento }), env: e, encoding: 'utf8',
  });
  return { status: r.status, stderr: r.stderr || '' };
}
// la puerta de la consola corre desde una copia propia del arnés, igual que el guion que nombra el comando: el freno
// reconoce un guion del arnés según el estado de git del clon
const consola = (h, command, tool_name = 'Bash', env) => {
  const { inHarnessCopy } = require(path.join(RAIZ, 'scripts', 'tests', 'lib', 'harness-copy.js'));
  return correr(inHarnessCopy(PUERTA), h, { tool_name, tool_input: { command: inHarnessCopy(command) } }, env);
};
const POR_CONSOLA = /se edita con la herramienta de edición/;
const BORRADO = /BORRADO DEL ESTADO DEL PIPELINE/;
const A_MANO = /update-story-status/;

// ── La historia escrita por consola (AC 1-2) ────────────────────────────────────────────────────────────────────────────

// stable-data: es el comando de la evidencia del laboratorio, que el portón juzga y nunca corre
const KIMI_ESTADO = "node -e \"const fs=require('fs');const f='specs/story-9.9-algo.md';let c=fs.readFileSync(f,'utf8');c=c.replace(/^status: in-progress$/m,'status: done');fs.writeFileSync(f,c);\"";

test('T1 CasoKimi_EstadoPorConsola_Frena @story-8.109 @ac-1 — el node -e del laboratorio, con el marcador abierto, cerrado y sin marcador', () => {
  for (const que of ['abierto', 'cerrado', 'sin marcador']) {
    const h = nuevaHome();
    const m = path.join(h.estado, 'active', `${SID}.json`);
    if (que === 'cerrado') fs.writeFileSync(m, JSON.stringify({ storyId: '9.9', repoPath: h.repo, stepsPending: [] }));
    if (que === 'sin marcador') fs.rmSync(m);
    const r = consola(h, KIMI_ESTADO);
    assert.strictEqual(r.status, 2, `${que}: ${r.stderr}`);
    assert.match(r.stderr, POR_CONSOLA, que);
    assert.match(r.stderr, A_MANO, `${que}: el cartel dice qué comando usar`);
  }
});

const FORMAS = [
  // el sed cambia el estado que tenga: uno que no encuentra qué cambiar no toca la historia, y pasa
  ['Bash', `sed -i '' 's/^status: .*/status: done/' ${HISTORIA}`],
  ['Bash', `perl -pi -e 's/in-progress/done/' ${HISTORIA}`],
  ['Bash', `cat > ${HISTORIA} <<'EOF'\n---\nstory: "9.9"\nstatus: done\n---\nEOF`],
  ['Bash', `echo x | tee ${HISTORIA}`],
  ['Bash', `cp specs/otra.md ${HISTORIA}`],
  ['Bash', `python3 -c "open('${HISTORIA}','w').write('x')"`],
  ['Bash', `F=${HISTORIA}; sed -i '' 's/a/b/' "$F"`],
  ['PowerShell', `Set-Content -Path ${HISTORIA} -Value x`],
];

test('T2 HistoriaPorConsola_TodasLasFormas_Frenan @story-8.109 @ac-1 — en in-progress, review y ready-for-dev', () => {
  for (const status of ['in-progress', 'review', 'ready-for-dev']) {
    for (const [herramienta, c] of FORMAS) {
      const r = consola(nuevaHome({ status }), c, herramienta);
      assert.strictEqual(r.status, 2, `${status} · ${c}: ${r.stderr}`);
      assert.match(r.stderr, POR_CONSOLA, `${status} · ${c}`);
    }
  }
});

test('T3 HistoriaPorConsola_LoDemasSinCambio @story-8.109 @ac-2 — el borrador sigue con su regla; lo que no es historia y los guiones pasan', () => {
  // un borrador escrito encima sin que se vea qué queda (un `sed -i`) frena: volver a draft y cerrarla por consola sería
  // el mismo cierre en dos pasos
  const borrador = consola(nuevaHome({ status: 'draft' }), `sed -i '' 's/a/b/' ${HISTORIA}`);
  assert.strictEqual(borrador.status, 2, borrador.stderr);
  assert.match(borrador.stderr, POR_CONSOLA);
  // reescrito entero con un heredoc que lo deja en borrador: lo juzga su regla de siempre (la constancia del validador)
  const entero = consola(nuevaHome({ status: 'draft' }), `cat > ${HISTORIA} <<'EOF'\n---\nepic: 9\nstory: "9.9"\ntitle: "Algo"\nstatus: draft\n---\n# Story 9.9\nEOF`);
  assert.doesNotMatch(entero.stderr, POR_CONSOLA, entero.stderr);
  const pasan = [
    `sed -i '' 's/a/b/' notas.md`,
    `echo x > specs/otra.md`,
    `mv ${HISTORIA} specs/story-9.9-otro-nombre.md`,
    `node ${path.join(SCRIPTS, 'marker.js')} update-story-status ${HISTORIA} review`,
  ];
  for (const c of pasan) {
    const r = consola(nuevaHome(), c);
    assert.strictEqual(r.status, 0, `${c}: ${r.stderr}`);
  }
});

// ── El cambio a review o done a mano (AC 3-4) ───────────────────────────────────────────────────────────────────────────

const editar = (h, viejo, nuevo) => ({ tool_name: 'Edit', tool_input: { file_path: h.historia, old_string: viejo, new_string: nuevo } });
const CON_PIPELINES = 'pipelines:\n  front:\n    status: in-progress\n';

test('T4 EdicionAMano_AReviewODone_Frena @story-8.109 @ac-3 — Edit, Write y apply_patch, aun con la exención de la prueba en vivo', () => {
  const casos = [
    ['Edit a done', (h) => editar(h, 'status: in-progress\ndod', 'status: done\ndod')],
    ['Edit a review', (h) => editar(h, 'status: in-progress\ndod', 'status: review\ndod')],
    ['Write a done', (h) => ({ tool_name: 'Write', tool_input: { file_path: h.historia,
      content: fs.readFileSync(h.historia, 'utf8').replace('status: in-progress', 'status: done') } })],
    ['pipelines a done', (h) => editar(h, '    status: in-progress\n', '    status: done\n'), CON_PIPELINES],
  ];
  for (const [que, evento, extra] of casos) {
    const h = nuevaHome({ herramienta: 'Edit', extra: `dod_runtime_exempt: true\n${extra || ''}` });
    const r = correr(ENCABEZADO, h, evento(h));
    assert.strictEqual(r.status, 2, `${que}: ${r.stderr}`);
    assert.match(r.stderr, A_MANO, `${que}: el cartel dice qué comando usar`);
    assert.match(r.stderr, /tycon-pipeline close/, que);
  }
  // Codex: su herramienta de edición es apply_patch, que el despachador traduce a un Edit
  const h = nuevaHome({ herramienta: 'apply_patch' });
  const parche = `*** Begin Patch\n*** Update File: ${h.historia}\n@@\n-status: in-progress\n+status: done\n*** End Patch\n`;
  const r = correr(PRE_EDIT, h, { tool_name: 'apply_patch', tool_input: { command: parche } });
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, A_MANO);
  // un tramo que no se encuentra se juzga por lo que el parche escribe
  const torcido = parche.replace('-status: in-progress', ' title: "Otro"\n-status: in-progress');
  const r2 = correr(PRE_EDIT, h, { tool_name: 'apply_patch', tool_input: { command: torcido } });
  assert.strictEqual(r2.status, 2, r2.stderr);
  assert.match(r2.stderr, A_MANO);
});

test('T5 EdicionAMano_ConFrase_YaNoPasa @story-8.109 @ac-4 @story-8.139 @ac-43 — la frase de la persona no abre el freno y el cartel nombra la firma de la ventana; vieja o sin conversación, frena', () => {
  // con la firma de la ventana sí pasa: SignFile_ConLaVentana_ElArchivoPasa (T45, owner-window.test.js)
  for (const frase of ['dale, autorizo cambiar el estado', 'autorizo TYCON_STATUS_GATE']) {
    const h = nuevaHome({ herramienta: 'Edit', conversacion: [deLaPersona(frase)] });
    const r = correr(ENCABEZADO, h, editar(h, 'status: in-progress\nqa', 'status: done\nqa'));
    assert.strictEqual(r.status, 2, `${frase}: ${r.stderr}`);
    assert.match(r.stderr, /marker\.js sign-file cambiar-el-estado/, frase);
  }
  for (const [que, conversacion] of [['de hace 31 minutos', [deLaPersona('autorizo cambiar el estado', 31)]], ['sin conversación', null]]) {
    const h = nuevaHome({ herramienta: 'Edit', conversacion });
    assert.strictEqual(correr(ENCABEZADO, h, editar(h, 'status: in-progress\nqa', 'status: done\nqa')).status, 2, que);
  }
});

test('T6 EdicionAMano_OtrosCambios_Pasan @story-8.109 @ac-3 — el cuerpo, otro campo, review a review; y el interruptor del ambiente', () => {
  const casos = [
    ['el cuerpo', 'in-progress', (h) => editar(h, 'Texto.', 'Texto nuevo.')],
    ['otro campo', 'in-progress', (h) => editar(h, 'title: "Algo"', 'title: "Algo más"')],
    ['review a review', 'review', (h) => editar(h, 'Texto.', 'Texto nuevo.')],
    ['ready-for-dev a in-progress', 'ready-for-dev', (h) => editar(h, 'status: ready-for-dev\nqa', 'status: in-progress\nqa')],
  ];
  for (const [que, status, evento] of casos) {
    const h = nuevaHome({ status, herramienta: 'Edit' });
    const r = correr(ENCABEZADO, h, evento(h));
    assert.strictEqual(r.status, 0, `${que}: ${r.stderr}`);
  }
  const h = nuevaHome({ herramienta: 'Edit' });
  const r = correr(ENCABEZADO, h, editar(h, 'status: in-progress\nqa', 'status: done\nqa'), { TYCON_STATUS_GATE: 'off' });
  assert.strictEqual(r.status, 0, `con el interruptor del ambiente: ${r.stderr}`);
});

// ── El borrado de los marcadores (AC 5-6) ───────────────────────────────────────────────────────────────────────────────

const MARCADOR = `~/.claude/.tycon-pipeline/active/${SID}.json`;

test('T7 CasoKimi_BorrarEstado_Frena @story-8.109 @ac-5 — rm, comodín, mv, la carpeta, un intérprete y PowerShell; esta sesión y otra', () => {
  const h0 = nuevaHome();
  const abs = path.join(h0.estado, 'active', `${SID}.json`);
  const casos = [
    ['Bash', `rm ${MARCADOR} && echo "marker borrado"`],
    ['Bash', `rm "$HOME/.claude/.tycon-pipeline/active/${SID}.json"`],
    ['Bash', 'rm -f ~/.claude/.tycon-pipeline/active/*.json'],
    ['Bash', 'rm ~/.claude/.tycon-pipeline/active.json'],
    ['Bash', 'rm ~/.claude/.tycon-pipeline/active/otra-sesion.json'],
    ['Bash', `mv ${MARCADOR} ~/x.json`],
    ['Bash', 'rm -rf ~/.claude/.tycon-pipeline'],
    ['Bash', 'rm -rf ~/.claude'],
    ['Bash', `node -e "require('fs').unlinkSync(process.env.HOME+'/.claude/.tycon-pipeline/active/${SID}.json')"`],
    ['Bash', `python3 -c "import os; os.remove('${abs}')"`],
    ['PowerShell', `Remove-Item ${abs}`],
  ];
  for (const [herramienta, c] of casos) {
    const h = herramienta === 'PowerShell' || c.startsWith('python3') ? h0 : nuevaHome();
    fs.writeFileSync(path.join(h.estado, 'active.json'), '{}');
    const r = consola(h, c, herramienta);
    assert.strictEqual(r.status, 2, `${c}: ${r.stderr}`);
    assert.match(r.stderr, BORRADO, c);
    assert.match(r.stderr, /marker\.js clear/, `${c}: el cartel dice qué comando usar`);
  }
});

test('T8 EstadoLeerYUsar_Pasa @story-8.109 @ac-6 — leer, copiar afuera, los comandos de marker.js y otros archivos', () => {
  const h = nuevaHome();
  const fuera = path.join(h.home, 'otro', 'active');
  fs.mkdirSync(fuera, { recursive: true });
  fs.writeFileSync(path.join(fuera, `${SID}.json`), '{}');
  fs.writeFileSync(path.join(h.estado, 'production-index.json'), '{}');
  const pasan = [
    `cat ${MARCADOR}`,
    'ls ~/.claude/.tycon-pipeline/active',
    `jq . ${MARCADOR}`,
    `cp ${MARCADOR} ~/copia.json`,
    `node ${path.join(SCRIPTS, 'marker.js')} clear`,
    `rm ${path.join(fuera, `${SID}.json`)}`,
    'rm ~/.claude/.tycon-pipeline/production-index.json',
  ];
  for (const c of pasan) {
    const r = consola(h, c);
    assert.strictEqual(r.status, 0, `${c}: ${r.stderr}`);
  }
});

// ── Costo (AC 7) ──────────────────────────────────────────────────────────────────────────────────────────────────────
// El costo de la puerta es, sobre todo, cuántos procesos lanza: cada proceso hijo cuesta 40 ms o más. Se cuentan, no se
// cronometran: los milisegundos de una máquina compartida cambian con su carga y daban rojo en pedidos que no tocaban la
// puerta. Un preload de Node anota cada llamada de `child_process` del gancho (y de los procesos Node que lance).

/** Un preload que anota en `TYCON_TEST_CHILD_LOG` cada proceso que se lanza; se escribe en una carpeta temporal. */
function contadorDeHijos() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-by-hand-hijos-'));
  const preload = path.join(dir, 'contar-hijos.js');
  fs.writeFileSync(preload, [
    "const cp = require('child_process'); const fs = require('fs'); const log = process.env.TYCON_TEST_CHILD_LOG;",
    "for (const f of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {",
    "  const original = cp[f];",
    "  cp[f] = function (...a) { try { fs.appendFileSync(log, `${f} ${String(a[0])}\\n`); } catch (_) {} return original.apply(this, a); };",
    "}",
  ].join('\n'));
  return { dir, preload };
}

/** Cuántos procesos lanza `gancho` al juzgar el comando `c`. */
function hijosDe(gancho, h, c, contador) {
  const log = path.join(contador.dir, `hijos-${Date.now()}-${Math.random()}.log`);
  correr(gancho, h, { tool_name: 'Bash', tool_input: { command: c } }, { NODE_OPTIONS: `--require "${contador.preload}"`, TYCON_TEST_CHILD_LOG: log });
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
}

// stable-data: T9 cuenta los procesos de la puerta; ninguna fecha entra en lo que se compara.
test('T9 Porton_NoSubeElCosto @story-8.109 @ac-7 — un comando común o una escritura no lanzan más procesos que antes', (t) => {
  const viejo = spawnSync('git', ['-C', RAIZ, 'show', '2b58150c:skills/tycon-pipeline/scripts/on-bash-write-gate.js'], { encoding: 'utf8' });
  // sin la historia del repo no hay puerta de antes con qué comparar: se saltea diciéndolo, no sale verde
  if (viejo.status !== 0) { t.skip('sin la historia del repo (2b58150c) no hay puerta de antes con qué comparar'); return; }
  // un árbol de juguete con las bibliotecas de éste y la puerta de antes
  const arbol = fs.mkdtempSync(path.join(os.tmpdir(), 'status-by-hand-costo-'));
  const dir = path.join(arbol, 'skills', 'tycon-pipeline', 'scripts');
  fs.mkdirSync(dir, { recursive: true });
  for (const n of fs.readdirSync(SCRIPTS)) if (n !== 'on-bash-write-gate.js') fs.symlinkSync(path.join(SCRIPTS, n), path.join(dir, n));
  fs.symlinkSync(path.join(RAIZ, 'scripts'), path.join(arbol, 'scripts'));
  const puertaVieja = path.join(dir, 'on-bash-write-gate.js');
  fs.writeFileSync(puertaVieja, viejo.stdout);
  const h = nuevaHome();
  const contador = contadorDeHijos();
  // dos comandos comunes (hoy no lanzan ningún proceso) y una escritura (hoy lanza los de git que la ubican)
  for (const c of ['ls -la', 'git status', 'echo hola > archivo.txt']) {
    const antes = hijosDe(puertaVieja, h, c, contador);
    const ahora = hijosDe(PUERTA, h, c, contador);
    // la escritura lanza procesos en la puerta de antes: si el contador no anotara nada, «0 contra 0» saldría verde
    if (c.startsWith('echo')) assert.ok(antes.length >= 1, `${c}: el contador no vio ningún proceso de la puerta de antes`);
    assert.ok(ahora.length <= antes.length,
      `${c}: la puerta lanza ${ahora.length} procesos y antes lanzaba ${antes.length}\n  antes: ${antes.join(' · ') || '—'}\n  ahora: ${ahora.join(' · ') || '—'}`);
  }
});

test('T9b Porton_ConteoVeUnProcesoDeMas @story-8.109 @ac-7 — el conteo ve un proceso de más y no depende del reloj', () => {
  // dos ganchos de juguete: uno lanza un proceso y el otro dos; el conteo los distingue, en cualquier máquina
  const contador = contadorDeHijos();
  const h = nuevaHome();
  const gancho = (n) => {
    const f = path.join(contador.dir, `gancho-${n}.js`);
    fs.writeFileSync(f, `const { spawnSync } = require('child_process'); for (let i = 0; i < ${n}; i++) spawnSync('git', ['--version']);\n`);
    return f;
  };
  assert.strictEqual(hijosDe(gancho(1), h, 'ls', contador).length, 1);
  assert.strictEqual(hijosDe(gancho(2), h, 'ls', contador).length, 2, 'un proceso de más se ve');
  assert.strictEqual(hijosDe(gancho(0), h, 'ls', contador).length, 0);
});

// ── Lo que encontró el pase adversarial ───────────────────────────────────────────────────────────────────────────────

test('T15 Adversarial_EstadoAMano_FormasDelArchivo @story-8.109 @ac-3 — CRLF, comillas, comentario, la marca de bytes y mover el done de tanda', () => {
  const casos = [
    ['CRLF', (t) => t.replace(/\n/g, '\r\n'), 'status: in-progress\r\n', 'status: done\r\n'],
    ['comillas simples', (t) => t, "status: in-progress\nqa", "status: 'done'\nqa"],
    ['comentario al final', (t) => t, 'status: in-progress\nqa', 'status: done  # cerrada\nqa'],
    ['marca de orden de bytes', (t) => `﻿${t}`, 'status: in-progress\nqa', 'status: done\nqa'],
  ];
  for (const [que, forma, viejo, nuevo] of casos) {
    const h = nuevaHome({ herramienta: 'Edit' });
    fs.writeFileSync(h.historia, forma(fs.readFileSync(h.historia, 'utf8')));
    const r = correr(ENCABEZADO, h, editar(h, viejo, nuevo));
    assert.strictEqual(r.status, 2, `${que}: ${r.stderr}`);
    assert.match(r.stderr, A_MANO, que);
  }
  // el done pasa de una tanda a otra: la cuenta de `status: done` queda igual
  const h = nuevaHome({ herramienta: 'Edit', extra: 'pipelines:\n  front:\n    status: done\n  back:\n    status: in-progress\n' });
  const r = correr(ENCABEZADO, h, editar(h, '  front:\n    status: done\n  back:\n    status: in-progress\n', '  front:\n    status: in-progress\n  back:\n    status: done\n'));
  assert.strictEqual(r.status, 2, `mover el done de tanda: ${r.stderr}`);
});

test('T16 Adversarial_ParcheDeCodex @story-8.109 @ac-3 — Add File y Update File sin tramos también se juzgan', () => {
  const h = nuevaHome({ herramienta: 'apply_patch' });
  const nueva = path.join(h.repo, 'specs', 'story-9.7-nueva.md');
  const agrega = `*** Begin Patch\n*** Add File: ${nueva}\n+---\n+story: "9.7"\n+title: "Nueva"\n+status: done\n+---\n+# Story 9.7\n*** End Patch\n`;
  // por el despachador (la forma real: un Write con el contenido) y como Edit con el parche (la forma del hallazgo)
  const r1 = correr(PRE_EDIT, h, { tool_name: 'apply_patch', tool_input: { command: agrega } });
  assert.strictEqual(r1.status, 2, r1.stderr);
  const r2 = correr(ENCABEZADO, h, { tool_name: 'Edit', tool_name_raw: 'apply_patch', tool_input: { file_path: nueva, command: agrega } });
  assert.strictEqual(r2.status, 2, r2.stderr);
  const sinTramos = `*** Begin Patch\n*** Update File: ${h.historia}\n-status: in-progress\n+status: done\n*** End Patch\n`;
  const r3 = correr(ENCABEZADO, h, { tool_name: 'Edit', tool_name_raw: 'apply_patch', tool_input: { file_path: h.historia, command: sinTramos } });
  assert.strictEqual(r3.status, 2, r3.stderr);
  assert.match(r3.stderr, A_MANO);
});

test('T17 Adversarial_HistoriaPorConsola_Comodines @story-8.109 @ac-1 — comodines, (cd …), pathlib, la marca de bytes y sin status', () => {
  const frenan = [
    "sed -i '' 's/a/b/' specs/story-9.*",
    "for f in specs/*.md; do sed -i '' 's/a/b/' $f; done",
    "ls specs/*.md | xargs sed -i '' 's/a/b/'",
    '(cd specs; echo x >> story-9.9-algo.md)',
    `python3 -c "import pathlib; pathlib.Path('${HISTORIA}').write_text('x')"`,
  ];
  for (const c of frenan) {
    const r = consola(nuevaHome(), c);
    assert.strictEqual(r.status, 2, `${c}: ${r.stderr}`);
    assert.match(r.stderr, POR_CONSOLA, c);
  }
  for (const [que, cambiar] of [['marca de orden de bytes', (t) => `﻿${t}`], ['sin status', (t) => t.replace(/^status: .*\n/m, '')]]) {
    const h = nuevaHome();
    fs.writeFileSync(h.historia, cambiar(fs.readFileSync(h.historia, 'utf8')));
    const r = consola(h, `sed -i '' 's/a/b/' ${HISTORIA}`);
    assert.strictEqual(r.status, 2, `${que}: ${r.stderr}`);
  }
  // leer con un comodín no es escribir
  for (const c of ['ls specs/*.md > lista.txt', 'grep -l status specs/*.md 2>/dev/null', 'for f in specs/*.md; do grep x $f; done']) {
    assert.strictEqual(consola(nuevaHome(), c).status, 0, c);
  }
});

test('T18 Adversarial_BorrarMarcador_Envoltorios @story-8.109 @ac-5 — bash -c, find, llaves, xargs, mover desde un guion y otros', () => {
  const h0 = nuevaHome();
  const S = h0.estado;
  const casos = [
    `sh -c 'rm -rf ${S}/active'`,
    `bash -c "rm ${S}/active/${SID}.json"`,
    `find ${S}/active -delete`,
    `find ${S}/active -type f -exec rm {} +`,
    `rm -rf ${S}/{active,active.json}`,
    `ls ${S}/active/*.json | xargs rm`,
    `shred -u ${S}/active/${SID}.json`,
    `rsync -a --delete /tmp/vacio/ ${S}/active/`,
    `node -e "require('fs').renameSync('${S}/active/${SID}.json','/tmp/x')"`,
    `node -e "require('fs').promises.rm('${S}/active',{recursive:true})"`,
    `python3 -c "import shutil; shutil.move('${S}/active/${SID}.json','/tmp/x')"`,
    `python3 -c "import os; os.rename('${S}/active/${SID}.json','/tmp/x')"`,
    `perl -e 'unlink "${S}/active/${SID}.json"'`,
    `ruby -e 'File.delete("${S}/active/${SID}.json")'`,
    `git -C ${S} clean -fdx`,
  ];
  for (const c of casos) {
    const r = consola(h0, c);
    assert.strictEqual(r.status, 2, `${c}: ${r.stderr}`);
    assert.match(r.stderr, BORRADO, c);
  }
  // un guion que borra otra cosa y sólo nombra el skill no frena
  const pasa = consola(h0, "node -e \"const t='/tmp/x'; /* tycon-pipeline */ require('fs').rmSync(t+Math.random(),{force:true})\"");
  assert.strictEqual(pasa.status, 0, pasa.stderr);
});

// ── Lo que encontraron los revisores ──────────────────────────────────────────────────────────────────────────────────

test('T19 Revisores_EstadoAMano_EnDosPasos @story-8.109 @ac-3 — sacar el encabezado, volver a borrador, otras formas de la clave; el interruptor deja constancia', () => {
  const casos = [
    ['sacar story: y pasar a done', 'story: "9.9"\ntitle: "Algo"\nstatus: in-progress', 'title: "Algo"\nstatus: done'],
    ['sacar el encabezado', '---\nepic: 9\nstory: "9.9"', 'epic: 9\nstory: "9.9"'],
    ['volver a borrador', 'status: in-progress\nqa', 'status: draft\nqa'],
    ['espacio antes de los dos puntos', 'status: in-progress\nqa', 'status : done\nqa'],
    ['clave entre comillas', 'status: in-progress\nqa', '"status": done\nqa'],
  ];
  for (const [que, viejo, nuevo] of casos) {
    const h = nuevaHome({ herramienta: 'Edit' });
    const r = correr(ENCABEZADO, h, editar(h, viejo, nuevo));
    assert.strictEqual(r.status, 2, `${que}: ${r.stderr}`);
    assert.match(r.stderr, A_MANO, que);
  }
  const h = nuevaHome({ herramienta: 'Edit' });
  const r = correr(ENCABEZADO, h, editar(h, 'status: in-progress\nqa', 'status: done\nqa'), { TYCON_STATUS_GATE: 'off' });
  assert.strictEqual(r.status, 0, r.stderr);
  const lineas = fs.readFileSync(path.join(h.estado, 'frenos.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const c = lineas.find((l) => l.freno === 'on-frontmatter-write' && l.regla === 'estado-a-mano');
  assert.deepStrictEqual(c && [c.veredicto, c.via, c.escape], ['escape', 'ambiente', 'TYCON_STATUS_GATE'], 'el interruptor deja su línea');
});

test('T20 Revisores_HistoriaPorConsola_OtrosEditores @story-8.109 @ac-1 — awk -i inplace, ruby -pi, ed y find -exec sed -i', () => {
  const frenan = [
    `awk -i inplace '{print}' ${HISTORIA}`,
    `ruby -pi -e 'gsub(/a/, "b")' ${HISTORIA}`,
    `printf ',s/in-progress/done/\\nw\\nq\\n' | ed -s ${HISTORIA}`,
    "find specs -name '*.md' -exec sed -i '' 's/a/b/' {} +",
  ];
  for (const c of frenan) {
    const r = consola(nuevaHome(), c);
    assert.strictEqual(r.status, 2, `${c}: ${r.stderr}`);
    assert.match(r.stderr, POR_CONSOLA, c);
  }
});

test('T21 Revisores_Vuelta2_CierreEnDosPasos @story-8.109 @ac-1 @ac-2 @ac-3 @ac-5 — cambiar el id, sacarla de .md, borrarla, reponerla, otras opciones de -i, el borrador del cuerpo y más formas de borrar el marcador', () => {
  // Edit que le cambia el id a uno que no es de trabajo (después se la cerraría sin que cuente como historia)
  const h1 = nuevaHome({ herramienta: 'Edit' });
  const r1 = correr(ENCABEZADO, h1, editar(h1, 'story: "9.9"', 'story: "x"'));
  assert.strictEqual(r1.status, 2, r1.stderr);
  assert.match(r1.stderr, A_MANO);
  // por consola: sacarla de .md, borrarla, reponer una versión vieja y otras formas de editar en el lugar
  const frenan = [
    `mv ${HISTORIA} /tmp/s.txt`,
    `rm ${HISTORIA}`,
    `git checkout HEAD -- ${HISTORIA}`,
    `perl -0pi -e 's/a/b/' ${HISTORIA}`,
    `sed -ibak 's/a/b/' ${HISTORIA}`,
    `sed -e 's/a/b/;s/c/d/' -i '' ${HISTORIA}`,
    `sed 's|a|b|' -i ${HISTORIA}`,
  ];
  for (const c of frenan) {
    const r = consola(nuevaHome(), c);
    assert.strictEqual(r.status, 2, `${c}: ${r.stderr}`);
    assert.match(r.stderr, POR_CONSOLA, c);
  }
  // un borrador reescrito con `status: done` en el encabezado y `status: draft` en el cuerpo no pasa por borrador
  const b = consola(nuevaHome({ status: 'draft' }), `cat > ${HISTORIA} <<'EOF'\n---\nstory: "9.9"\nstatus: done\n---\n# Story 9.9\nstatus: draft\nEOF`);
  assert.strictEqual(b.status, 2, b.stderr);
  assert.match(b.stderr, POR_CONSOLA);
  // más formas de borrar o mover el marcador
  const h0 = nuevaHome();
  const S = h0.estado;
  for (const [herramienta, c] of [
    ['Bash', `rmdir ${S}/active`], ['Bash', `unlink ${S}/active/${SID}.json`],
    ['Bash', `node -e "require('fs').rmSync('${S}/active',{recursive:true})"`],
    ['Bash', `python3 -c "import shutil; shutil.rmtree('${S}/active')"`],
    ['PowerShell', `del ${S}/active/${SID}.json`], ['PowerShell', `Move-Item ${S}/active/${SID}.json C:/x.json`],
  ]) {
    const r = consola(h0, c, herramienta);
    assert.strictEqual(r.status, 2, `${c}: ${r.stderr}`);
    assert.match(r.stderr, BORRADO, c);
  }
});

test('T22 Revisores_Vuelta3_MismaFamilia @story-8.109 @ac-1 @ac-3 @ac-5 — rutas y alias del comando, copiadores, carpetas, guiones que copian, estado repetido y comodín del medio', () => {
  const frenan = [
    `git mv ${HISTORIA} specs/story-9.9-algo.txt`,
    `/bin/mv ${HISTORIA} /tmp/s.txt`,
    `\\rm ${HISTORIA}`,
    `install /tmp/s.txt ${HISTORIA}`,
    `rsync /tmp/s.txt ${HISTORIA}`,
    `curl -o ${HISTORIA} http://localhost/x`,
    'git checkout otra-rama -- specs/',
    "grep -rl x specs | xargs sed -i '' 's/a/b/'",
    `python3 -c "import glob\nfor f in glob.glob('specs/*.md'): open(f,'w').write('x')"`,
    `node -e "require('fs').copyFileSync('/tmp/s.txt','${HISTORIA}')"`,
  ];
  for (const c of frenan) {
    const r = consola(nuevaHome(), c);
    assert.strictEqual(r.status, 2, `${c}: ${r.stderr}`);
    // con la ejecución abierta, un guion que escribe en un destino armado lo frena antes el freno de la edición invisible
    assert.match(r.stderr, /HISTORIA ESCRITA POR CONSOLA|EDICIÓN INVISIBLE/, c);
  }
  // sin ejecución abierta, el mismo guion lo frena la historia por consola
  const sinMarcador = nuevaHome();
  fs.rmSync(path.join(sinMarcador.estado, 'active', `${SID}.json`));
  const py = consola(sinMarcador, frenan[8]);
  assert.match(py.stderr, POR_CONSOLA, py.stderr);
  // un borrador reescrito con dos `status:` en el encabezado (draft y done) no pasa por borrador
  const b = consola(nuevaHome({ status: 'draft' }), `cat > ${HISTORIA} <<'EOF'\n---\nstory: "9.9"\nstatus: draft\nstatus: done\n---\n# Story 9.9\nEOF`);
  assert.strictEqual(b.status, 2, b.stderr);
  // reponer sin cambios no cambia nada: `git restore .` con la historia igual al commit pasa
  const limpio = nuevaHome();
  const git = (...a) => spawnSync('git', ['-C', limpio.repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a]);
  git('add', '-A'); git('commit', '-qm', 'x');
  const restore = consola(limpio, 'git restore .');
  assert.strictEqual(restore.status, 0, restore.stderr);
  // un Edit que agrega un `status: done` antes del que estaba (cada lector se queda con uno distinto)
  const h = nuevaHome({ herramienta: 'Edit' });
  const r = correr(ENCABEZADO, h, editar(h, 'status: in-progress\nqa', 'status: done\nstatus: in-progress\nqa'));
  assert.strictEqual(r.status, 2, r.stderr);
  // el marcador: con la ruta del comando, con la barra, con un comodín en una carpeta del medio, desde ruby
  const h0 = nuevaHome();
  const S = h0.estado;
  for (const c of [
    `/bin/rm -rf ${S}/active`,
    `\\rm ${S}/active/${SID}.json`,
    `rm -rf ${path.dirname(S)}/.tycon-p*/active`,
    `ruby -e 'require "fileutils"; FileUtils.rm_rf("${S}/active")'`,
  ]) {
    const x = consola(h0, c);
    assert.strictEqual(x.status, 2, `${c}: ${x.stderr}`);
    assert.match(x.stderr, BORRADO, c);
  }
});

test('T11 Guia_CierreAMano @story-8.109 — la guía del freno dice qué frena y qué usar en su lugar', () => {
  const guia = fs.readFileSync(path.join(RAIZ, 'guides', 'safety-guard.md'), 'utf8');
  for (const frase of ['por consola', 'cambiar el estado', 'BORRADO DEL ESTADO DEL PIPELINE', 'update-story-status', 'clear-session']) {
    assert.ok(guia.includes(frase), `la guía no trae «${frase}»`);
  }
});

// ── El cierre por drift (AC 3) ───────────────────────────────────────────────────────────────────────────────────────

test('T12 DriftCierre_UsaElComando @story-8.109 @ac-3 — el paso 5 de check-story-drift aplica el done con el comando', () => {
  const paso = fs.readFileSync(path.join(RAIZ, 'skills', 'check-story-drift', 'steps', 'step-05-hitl-action.md'), 'utf8');
  assert.match(paso, /marker\.js update-story-status/);
  assert.doesNotMatch(paso, /frontmatter `status: done`/, 'ya no propone el done con Edit');
});

// ── Borrar la rama de un pedido (@story-8.113) ────────────────────────────────────────────────────────────────
// `gh pr close|merge … --delete-branch` borra una rama de git. Con la carpeta del estado llamada `state` (la casa propia,
// `~/.tycon/state`), un `--json state` en el mismo comando la nombra y el freno lo toma por un borrado del estado. Queda
// como freno aceptado por duda: la palabra `--delete-branch` es lo único que abre la regla para formas de borrar que la
// lista de verbos no conoce (`zip -m`, `rsync --remove-source-files`, …), y quitarla las deja pasar.

/** Una HOME cuya carpeta del estado es `~/.tycon/state`, con el marcador de la sesión abierto. */
function nuevaHomeDeEstado() {
  const h = nuevaHome();
  const estado = path.join(h.home, '.tycon', 'state');
  fs.mkdirSync(path.join(estado, 'active'), { recursive: true });
  fs.copyFileSync(path.join(h.estado, 'active', `${SID}.json`), path.join(estado, 'active', `${SID}.json`));
  return { ...h, estado };
}

const COMENTARIO = '"Cerrado: lo reemplaza el pedido nuevo."';

// T5 BorrarRama_AceptadoPorDuda_Frena @story-8.113 @ac-5 @ac-8
// El caso real frena a propósito (AC 8), y su salida es separar el cierre del pedido de la lectura de su estado. Las
// formas de borrar que la lista de verbos no conoce, con un `gh pr close --delete-branch` en el mismo comando, borran
// o mueven el marcador de verdad: frenan.
// 🔴 Falla con: `--delete-branch` quitado de lo que lee la regla de borrar, sin otra forma de ver el borrado.
test('8.113 T5 BorrarRama_AceptadoPorDuda_Frena', () => {
  const h = nuevaHomeDeEstado();
  const E = h.estado;
  for (const c of [
    `for n in 443 444 445 446; do gh pr close $n --delete-branch --comment ${COMENTARIO}; done; for n in 443 444 445 446; do gh pr view $n --json state --jq '.state'; done`,
    'gh pr merge 5 --delete-branch --json state',
    `gh pr merge 5 --delete-branch && rsync -a --remove-source-files ${E}/active /tmp/x`,
    `gh pr close 1 --delete-branch && zip -qrm /tmp/a.zip ${E}/active.json ${E}/active`,
    `gh pr close 1 --delete-branch; tar -cf /tmp/a.tar --remove-files ${E}/active`,
    `gh pr close 1 --delete-branch && 7z a -sdel /tmp/a.7z ${E}/active`,
    `gh pr close 1 --delete-branch; rename s/active/zz/ ${E}/active`,
    `gh pr close 1 --delete-branch && ruby -e 'File.delete "${E}/active/${SID}.json"'`,
    `gh pr close 1 --delete-branch && perl -e 'rename "${E}/active","/tmp/q"'`,
    `gh pr close 1 --delete-branch; perl -e 'system qq(r).qq(m -rf ${E}/active)'`,
  ]) {
    const r = consola(h, c);
    assert.strictEqual(r.status, 2, `${c}: ${r.stderr}`);
    assert.match(r.stderr, BORRADO, c);
  }
  // cada mitad por separado pasa: es la salida que dice la guía
  for (const c of [`gh pr close 7 --delete-branch --comment ${COMENTARIO}`, 'gh pr view 7 --json state --jq .state']) {
    const r = consola(h, c);
    assert.strictEqual(r.status, 0, `${c}: ${r.stderr}`);
  }
});

// T6 BorrarRama_Variantes_SiguenComoHoy @story-8.113 @ac-6
// Lo que dio el freno de origin/main (dd244205) con cada variante, medido al empezar la tanda: todas frenaban «BORRADO
// DEL ESTADO DEL PIPELINE». Siguen frenando.
// 🔴 Falla con: una excepción para `--delete-branch` que se extiende a otra opción `--delete…`, a un `gh` que no es la
//    palabra de comando o a un comentario.
test('8.113 T6 BorrarRama_Variantes_SiguenComoHoy', () => {
  const h = nuevaHomeDeEstado();
  const E = h.estado;
  for (const c of [
    `rsync -a --delete x/ ${E}/`,
    `rsync --delete-after x/ ${E}/`,
    `git push origin --delete-branch ${E}`,
    `gh pr close 1 --delete-branch; rm -rf ${E}`,
    'gh pr close 1 --delete-branch=true --json state',
    'gh pr close 1 -delete-branch --json state',
    'gh pr close 1 --delete-branchX --json state',
    '/usr/bin/gh pr close 1 --delete-branch --json state',
    'PATH=/tmp/x:$PATH gh pr close 1 --delete-branch --json state',
    'echo 1 | xargs gh pr close --delete-branch --json state',
    'gh pr close 1 --delete-branch --comment "move it" --json state',
    `bash -c 'gh pr close 1 --delete-branch' && ls ${E}`,
  ]) {
    const r = consola(h, c);
    assert.strictEqual(r.status, 2, `${c}: ${r.stderr}`);
    assert.match(r.stderr, BORRADO, c);
  }
});

// T7 BorrarRama_BorradoRealDelMarcador_Frena @story-8.113 @ac-6 @ac-7
// 🔴 Falla con: un borrado real tapado por el `gh pr close --delete-branch` de otro tramo, o escondido adentro del suyo.
test('8.113 T7 BorrarRama_BorradoRealDelMarcador_Frena', () => {
  const h = nuevaHomeDeEstado();
  const E = h.estado;
  for (const c of [
    `gh pr close 1 --delete-branch && rm -rf ${E}/active`,
    `gh pr close 1 --delete-branch && \\rm ~/.tycon/state/active/${SID}.json`,
    `gh pr close 1 --delete-branch && find $HOME/.tycon/state -name 'active*' -delete`,
    `gh pr close 1 --delete-branch && mv ${E}/active* /tmp/`,
    `gh pr close 1 --delete-branch --comment "$(rm -rf ${E})"`,
    `gh pr close 1 --delete-branch --comment "\`rm -rf ${E}\`"`,
    `gh pr close 1 --delete-branch & rm -rf ${E}`,
    `gh pr close 1 --delete-branch && ( rm -rf ${E} )`,
    `gh pr close 1 --delete-branch && { rm -rf ${E}; }`,
    `gh pr close 1 --delete-branch && rm -rf ~/.tycon/st*`,
    `gh pr close 1 --delete-branch && git clean -fdx ${E}/active`,
    `gh pr close 1 --delete-branch\nrm -rf ${E}`,
    `gh pr close 1 --delete-branch --body-file <(rm -rf ${E})`,
    `gh(){ rm -rf ${E}; }; gh pr close 1 --delete-branch`,
  ]) {
    const r = consola(h, c);
    assert.strictEqual(r.status, 2, `${JSON.stringify(c)}: ${r.stderr}`);
    assert.match(r.stderr, BORRADO, c);
  }
});

// BorrarEstado_PalabraSuelta_NoAbreLaRegla
// Medido en un día de conversaciones: los tres frenos «BORRADO DEL ESTADO DEL PIPELINE» eran comandos que no borraban
// nada. Lo que abría la regla era la palabra castellana «del» (el alias de Windows) en un texto, un `find -exec` con un
// programa que sólo lee, o un `git checkout --` que dice sus rutas, junto a la palabra `state` suelta en otro lado.
// 🔴 Falla con: los alias cortos de Windows leídos en cualquier lugar del texto, un `-exec wc` tomado por borrado, o el
//    nombre suelto de la carpeta del estado contado contra un `git checkout` cuyas rutas no la nombran.
test('BorrarEstado_PalabraSuelta_NoAbreLaRegla', () => {
  const h = nuevaHomeDeEstado();
  const E = h.estado;
  for (const c of [
    `node mockup.js render --data - <<'JSON'\n{"state": "abierto", "summary": "la deuda del cliente"}\nJSON`,
    `find ${E} -maxdepth 1 -name '*.log' -exec wc -l {} \\;`,
    `git checkout -- adapters/codex/ && git status --short; gh pr view 578 --json headRefName,state -q .state`,
  ]) {
    const r = consola(h, c);
    assert.strictEqual(r.status, 0, `${JSON.stringify(c)}: ${r.stderr}`);
  }
  // lo que borra de verdad sigue frenando, con las mismas tres formas cerca
  for (const c of [
    `del ${E}/active/${SID}.json`,
    `cmd /c del ${E}/active/${SID}.json`,
    `echo "la deuda del cliente"; rm -rf ${E}`,
    `find ${E} -name '*.json' -exec sh -c 'cat "$1"' _ {} \\;`,
    `find ${E} -exec wc -l {} \\; -exec rm {} \\;`,
    `find ${E} -exec wc -l {} \\; -delete`,
    `git checkout -- ${E}/active`,
    `git checkout -- src/a.js; rm -rf ${E}`,
    `git checkout -- src/a.js && bash -c 'rm -rf ~/.tycon/state'`,
  ]) {
    const r = consola(h, c);
    assert.strictEqual(r.status, 2, `${JSON.stringify(c)}: ${r.stderr}`);
    assert.match(r.stderr, BORRADO, c);
  }
});

// TextoCitado_NoEsComando
// Dos frenos falsos del mismo día: un `grep` de sólo lectura cuyo patrón citaba un `sed` que edita en el lugar frenó
// «HISTORIA ESCRITA POR CONSOLA», y la descripción de un pedido que contaba en prosa cómo se borraba la carpeta del estado
// frenó «BORRADO DEL ESTADO DEL PIPELINE». El patrón de un buscador y el texto de una descripción, un cuerpo o un mensaje
// se citan: no se ejecutan.
// 🔴 Falla con: la palabra entre comillas leída como comando cuando sólo la busca un `grep` o sólo la lleva un mensaje.
test('TextoCitado_NoEsComando', () => {
  const h = nuevaHomeDeEstado();
  const E = h.estado;
  for (const c of [
    `grep -n "sed -i 's/x/y/'" ${HISTORIA}`,
    `rg -n "sed -i 's/x/y/'" specs/`,
    'az repos pr create --title "Freno" --description "Un gh pr close --delete-branch borraba ~/.tycon/state/active/ y se perdía el marcador."',
    'gh pr create --title "Freno" --body "Antes, rm -rf ~/.tycon/state/active borraba el marcador."',
    `git commit -m "Ya no se usa sed -i 's/x/y/' sobre ${HISTORIA}"`,
  ]) {
    const r = consola(h, c);
    assert.strictEqual(r.status, 0, `${JSON.stringify(c)}: ${r.stderr}`);
  }
  // lo que se ejecuta de verdad, con el mismo texto cerca, sigue frenando
  for (const c of [
    `grep -n x ${HISTORIA} && sed -i '' 's/status: in-progress/status: done/' ${HISTORIA}`,
    `grep -l x specs/*.md | xargs sed -i '' 's/a/b/'`,
    `echo "sed -i '' 's/x/y/' ${HISTORIA}" | sh`,
    `rg --pre "sed -i '' 's/x/y/'" x ${HISTORIA}`,
    // las opciones con las que el buscador ejecuta el texto, y la salida que va a un shell detrás de otro programa
    `ag --pager "sed -i '' 's/x/y/' ${HISTORIA}" x .`,
    `git grep -O"sed -i '' 's/x/y/' ${HISTORIA}" x`,
    `grep -h "sed -i '' 's/x/y/' ${HISTORIA}" notas.txt | env sh`,
    `grep -h "sed -i '' 's/x/y/' ${HISTORIA}" notas.txt | sudo bash`,
    // `-m` es un mensaje en git y gh; en otro programa no se sabe
    `xyz -m "sed -i '' 's/x/y/' ${HISTORIA}"`,
    `az repos pr create --title "Freno" --description "$(rm -rf ${E})"`,
    `gh pr create --title "Freno" --body "x" && rm -rf ${E}`,
  ]) {
    const r = consola(h, c);
    assert.strictEqual(r.status, 2, `${JSON.stringify(c)}: ${r.stderr}`);
  }
});

// EdicionFueraDelRepo_NoEsLaHistoria
// Un `sed -i` sobre un guion del scratchpad, y después `expect` corriendo desde una carpeta de laboratorio, con la sesión
// parada en un repo con historias: nada escribe en specs/, y el freno listaba todas las historias del repo. El freno mira
// el destino real de la edición, no la carpeta donde está parada la sesión.
// 🔴 Falla con: el destino de la edición o la carpeta de trabajo del comando leídos como la carpeta de la sesión.
test('EdicionFueraDelRepo_NoEsLaHistoria', () => {
  const h = nuevaHome();
  const S = fs.mkdtempSync(path.join(os.tmpdir(), 'scratchpad-'));
  fs.mkdirSync(path.join(S, 'lab'));
  fs.writeFileSync(path.join(S, 'auto.exp'), 'spawn claude -p x\n');
  const muñe = `S=${S}; L=$S/lab; sed -i '' 's/^spawn claude /spawn env -u CLAUDE_CODE_CHILD_SESSION claude /' "$S/auto.exp"; `
    + `grep -n '^spawn' "$S/auto.exp"; cd "$L" && rm -f out-exempt.txt; N0=$(wc -l < hook-input.log); `
    + `expect "$S/auto.exp" "$S/B2.log" yes 'Run exactly this bash command once, without changing it: ./exempt.sh --critical SEC-C1 --reason "the owner exempts it"' > "$S/B2.out" 2>&1; `
    + `grep -E '###|line [0-9]+' "$S/B2.out"; ls | grep out-exempt; echo "hook nuevas: $(( $(wc -l < hook-input.log) - N0 ))"`;
  for (const c of [muñe, `S=${S}; sed -i '' 's/^spawn claude /spawn env claude /' "$S/auto.exp"`]) {
    const r = consola(h, c);
    assert.strictEqual(r.status, 0, `${JSON.stringify(c.slice(0, 120))}: ${r.stderr}`);
  }
  // el mismo sed sobre la historia, con el destino armado igual, sigue frenando; también con una cuenta que no asigna
  // cerca, y con una que sí asigna (el freno ya no sabe qué vale la variable)
  for (const c of [
    `S=${h.repo}; sed -i '' 's/^status: .*/status: done/' "$S/${HISTORIA}"`,
    `S=${h.repo}; sed -i '' 's/^status: .*/status: done/' "$S/${HISTORIA}"; echo "$(( $(wc -l < x) - 1 ))"`,
    `S=${h.repo}; : $(( N = 1 )); sed -i '' 's/^status: .*/status: done/' "$S/${HISTORIA}"`,
    // la variable de la cuenta vale una asignación: el shell la evalúa y cambia `D`
    `D=/tmp; e=D=0; : $((e)); sed -i '' 's/^status: .*/status: done/' "$D/../${HISTORIA}"`,
    `S=${h.repo}; e=S=0; echo $((e)) > /dev/null; sed -i '' 's/^status: .*/status: done/' "$S/${HISTORIA}"`,
  ]) {
    const r = consola(h, c);
    assert.strictEqual(r.status, 2, `${JSON.stringify(c.slice(0, 120))}: ${r.stderr}`);
  }
});

// EdicionSinFormaConocida_PalabraQueNoEsArchivo
// Con un editor en el lugar que el freno no sabe leer (`sed -i ''` con el sed de GNU, de Linux y de Git Bash; `perl -i`
// en cualquier sistema), cada palabra del comando cuenta como destino. El `))` de una cuenta quedaba vacío sin sus
// paréntesis y caía en la carpeta de la sesión: frenaba por todas sus historias. Un destino real sigue frenando.
// 🔴 Falla con: una palabra que no nombra un archivo (vacía, o la `/` suelta de un guion) leída como carpeta.
test('EdicionSinFormaConocida_PalabraQueNoEsArchivo', () => {
  const h = nuevaHome();
  const S = fs.mkdtempSync(path.join(os.tmpdir(), 'scratchpad-'));
  fs.writeFileSync(path.join(S, 'auto.exp'), 'spawn claude -p x\n');
  for (const c of [
    `S=${S}; perl -i -pe 's/^spawn claude /spawn env claude /' "$S/auto.exp"; echo "$(( $(wc -l < x) - 1 ))"`,
    `S=${S}; perl -i -pe 's/^spawn claude /spawn env claude /' "$S/auto.exp"; : $(( N = 1 ))`,
    `S=${S}; perl -i -pe 's/^spawn claude /spawn env claude /' "$S/auto.exp"`,
  ]) {
    const r = consola(h, c);
    assert.strictEqual(r.status, 0, `${JSON.stringify(c.slice(0, 120))}: ${r.stderr}`);
  }
  // la historia nombrada, una carpeta con historias, o la cuenta en el mismo comando: siguen frenando
  for (const c of [
    `perl -i -pe 's/^status: .*/status: done/' ${HISTORIA}; echo "$(( $(wc -l < x) - 1 ))"`,
    `S=${h.repo}; perl -i -pe 's/^status: .*/status: done/' "$S/${HISTORIA}"; : $(( N = 1 ))`,
    `grep -rl x specs | xargs perl -i -pe 's/^status: .*/status: done/'; echo "$(( 1 + 1 ))"`,
  ]) {
    const r = consola(h, c);
    assert.strictEqual(r.status, 2, `${JSON.stringify(c.slice(0, 120))}: ${r.stderr}`);
  }
});
