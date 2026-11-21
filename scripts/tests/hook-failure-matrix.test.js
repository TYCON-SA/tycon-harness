'use strict';
// hook-failure-matrix.test.js — la matriz de fallas de los frenos (historia 8.159): cada freno de la tabla
// (scripts/setup/hook-failure-policy.json), con cada modo de falla; y los caminos que hoy frenan al fallar, protegidos.
// Para los frenos que no son de publicación, la matriz mide: escribe la tabla de lo que hace hoy cada freno y no falla
// por una diferencia con su clase. Lo que sí exige: un caso por modo que aplica, el motivo de cada modo que no, y que
// cada camino que hoy frena al fallar siga frenando. El freno de publicación ya exige su clase entera.
// Todo aislado: casa temporal, un clon falso, sin red. Nada escribe en los registros de la máquina.
// Correr: cd scripts/tests && HOME=$(mktemp -d) node --test hook-failure-matrix.test.js < /dev/null
// La tabla medida va a $TYCON_HOOK_MATRIX_OUT (si no, a una carpeta temporal que se borra).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ROOT, GUARD, LAUNCHER, lab } = require('./lib/public-guard-lab.js');
const HL = require('./lib/hook-failure-lab.js');
const { CASOS, CONTROLES } = require('./lib/hook-failure-cases.js');

const POLICY = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'setup', 'hook-failure-policy.json'), 'utf8'));
const fila = POLICY.frenos.find((f) => f.guion === 'public-push-guard.js');
const EN_TERRENO = 'gh pr create -R TYCON-SA/tycon-harness --title t --body b';
const FUERA = 'ls -la';

test('Policy_PublicPush_RowWithClassTerrainAndPaths @story-8.159 @ac-0 — su renglón: crítico, su terreno, sus caminos y ningún timeout', () => {
  assert.ok(fila, 'el freno de publicación tiene su renglón');
  assert.strictEqual(fila.clase, 'critico');
  assert.match(fila.terreno, /gh/);
  assert.match(fila.terreno, /push/);
  assert.deepStrictEqual(fila.salidas_1_a_proposito, [], 'publicación no usa salidas 1');
  assert.strictEqual(fila.timeout_del_instalador, null);
  assert.strictEqual(fila.lanzador, 'node-missing-launcher.sh');
  const list = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'setup', 'hooks-list.json'), 'utf8'));
  const reg = list.hooks.find((h) => h.spec === '@tcg:public-push-guard.js');
  assert.ok(reg && reg.effect === 'blocks' && reg.event === fila.evento, 'el renglón corresponde a un registro que frena');
  assert.strictEqual(reg.launcher, fila.lanzador, 'la lista registra el mismo lanzador');
});

test('T11 Matrix_FailClosedToday_EveryPathStillBlocks @story-8.159 @ac-0 — cada camino que hoy frena al fallar sigue frenando', (t) => {
  const L = lab(t);
  const casos = {
    'entrada-sin-comando-con-gh': () => L.correr(`esto no es json ${EN_TERRENO}`),
    'error-propio-con-gh-o-push': () => [L.correr(L.evento(EN_TERRENO), { guion: L.sola }), L.correr(L.evento('git push origin main'), { guion: L.sola })],
    'error-en-la-salida-principal': () => [L.correr(L.evento(EN_TERRENO), { guion: L.roto('throw') }), L.correr(L.evento(FUERA), { guion: L.roto('throw') })],
    'sin-node-en-su-terreno': () => L.correr(L.evento(EN_TERRENO), { argv: ['/bin/bash', LAUNCHER, 'node-que-no-esta', GUARD] }),
    'reloj-vencido-en-su-terreno': () => L.correr(L.evento(EN_TERRENO), { guion: L.roto('hang'), extra: { TYCON_PUBLIC_GUARD_CLOCK_MS: '400' } }),
  };
  for (const c of [...fila.fail_closed_today, ...fila.fail_closed_new]) {
    assert.ok(casos[c.camino], `el camino «${c.camino}» tiene su caso en la matriz`);
    for (const r of [].concat(casos[c.camino]())) assert.strictEqual(r.code, 2, `${c.camino}: frena (${r.err.slice(0, 160)})`);
  }
});

test('Matrix_PublicPush_EveryModeInTerrainBlocks_OutsidePasses @story-8.159 @ac-0 — cada modo de falla, con y sin su terreno', (t) => {
  const L = lab(t);
  const sinGit = L.pathSin('git');
  const modos = {
    'no es JSON': (cmd) => L.correr(`no es json ${cmd}`),
    'JSON sin el campo': (cmd) => L.correr(JSON.stringify({ tool_input: { otra: cmd } })),
    'sin sus bibliotecas': (cmd) => L.correr(L.evento(cmd), { guion: L.sola }),
    'sin node': (cmd) => L.correr(L.evento(cmd), { argv: ['/bin/bash', LAUNCHER, 'node-que-no-esta', GUARD] }),
    'reloj vencido': (cmd) => L.correr(L.evento(cmd), { guion: L.roto('hang'), extra: { TYCON_PUBLIC_GUARD_CLOCK_MS: '400' } }),
  };
  // la entrada vacía no puede traer un `gh`: sólo tiene su variante fuera del terreno
  const vacia = L.correr('');
  assert.strictEqual(vacia.code, 0, `vacía: pasa (${vacia.err.slice(0, 160)})`);
  assert.match(vacia.err, /no freno, pero tampoco miré/, 'vacía: lo dice');
  // sin git el freno no queda ciego: revisa el texto y decide igual que con git (en el laboratorio, sin la lista del
  // equipo, deja pasar el `gh` revisado). Lo que se exige es que no lo tome por una falla propia
  for (const cmd of [EN_TERRENO, FUERA]) {
    const con = L.correr(L.evento(cmd));
    const sin = L.correr(L.evento(cmd), { extra: { PATH: sinGit } });
    assert.strictEqual(sin.code, con.code, `sin git, ${cmd}: decide igual que con git (${sin.err.slice(0, 160)})`);
    assert.doesNotMatch(sin.err, /falló por dentro/, `sin git, ${cmd}: no es una falla propia`);
  }
  for (const [modo, correr] of Object.entries(modos)) {
    const dentro = correr(EN_TERRENO);
    assert.strictEqual(dentro.code, 2, `${modo}, con un gh que publica: frena (${dentro.err.slice(0, 160)})`);
    const fuera = correr(FUERA);
    assert.strictEqual(fuera.code, 0, `${modo}, fuera de su terreno: pasa (${fuera.err.slice(0, 160)})`);
  }
});

// ── Los otros dieciséis registros y el freno de producción ───────────────────────────────────────────────────────────

const POL = HL.leerPolicy();
const LISTA = HL.leerLista();
const SUITES = JSON.stringify(JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'tests', 'suites.json'), 'utf8')));
// los modos de falla de la matriz; cada renglón corre los que le aplican y declara los demás con su motivo
const MODOS = ['not-json', 'empty', 'json-without-field', 'missing-library', 'without-node', 'without-jq-or-node', 'without-ps', 'without-git'];
const PROPIOS_DE_SHELL = new Set(['without-jq-or-node']);
const claveDe = (f) => `${f.spec}\0${f.evento}\0${f.matcher}`;
const guionDe = (f) => (f.guion_repo ? path.join(ROOT, f.guion_repo) : HL.rutaDelSpec(f.spec));
const esDeOtraHistoria = (f) => Boolean(f.owner && f.owner.todos);
const enEstaPlataforma = (f) => process.platform !== 'win32' || (f.plataformas && f.plataformas.windows);

/** Los modos que el renglón corre: los de la lista menos los que declara que no le aplican (y los de shell en Node). */
function modosDe(f) {
  return MODOS.filter((m) => !(f.modos_que_no_aplican || {})[m] && !(PROPIOS_DE_SHELL.has(m) && !f.guion.endsWith('.sh')));
}

/** El texto del comando o del evento típico del renglón, y su evento armado sobre `cwd`. */
function eventoDe(f, entrada, cwd) {
  if (typeof entrada === 'string') {
    const tool = String(f.matcher || 'Bash').split('|')[0] || 'Bash';
    return { texto: entrada, json: JSON.stringify({ hook_event_name: f.evento, session_id: SID_DE_LA_MEDICION, tool_name: tool, cwd, tool_input: { command: entrada } }) };
  }
  const ev = { hook_event_name: f.evento, session_id: SID_DE_LA_MEDICION, cwd, ...entrada };
  return { texto: JSON.stringify(entrada), json: JSON.stringify(ev) };
}

/** Corre el renglón con un modo y una entrada: el resultado en una palabra (`frena`, `pasa` o el código). */
function correrModo(L, f, modo, entrada, cwd) {
  const g = guionDe(f);
  const { texto, json } = eventoDe(f, entrada, cwd);
  const extra = { ...(f.encendido || {}) };
  const o = { extra, cwd };
  let input = json;
  if (modo === 'not-json') input = `no es json ${texto}`;
  else if (modo === 'empty') input = '';
  else if (modo === 'json-without-field') input = JSON.stringify(f.evento === 'Stop' ? { otra: texto } : { tool_input: { otra: texto } });
  else if (modo === 'missing-library') o.guion = L.solo(g);
  else if (modo === 'without-node') {
    o.PATH = L.pathSin(['node']);
    // la línea que escribe el instalador sin el Node propio del arnés: `node "<guion>"`, o detrás de su lanzador si lo
    // lleva; un guion de shell, tal cual
    const lanzador = f.lanzador && !f.lanzador_repo ? path.join(ROOT, 'scripts', 'hooks', f.lanzador) : null;
    if (lanzador) o.argv = ['/bin/bash', lanzador, 'node', g];
    else if (!g.endsWith('.sh')) o.argv = ['/bin/bash', '-c', `node "${g}"`];
  } else if (modo === 'without-jq-or-node') o.PATH = L.pathSin(['jq', 'node']);
  else if (modo === 'without-ps') o.PATH = L.pathSin(['pgrep', 'ps']);
  else if (modo === 'without-git') o.PATH = L.pathSin(['git']);
  return HL.resultado(L.correr(g, input, o));
}

// la entrada típica de los frenos que leen el comando de una plataforma: vive acá y no en la tabla, que es del núcleo
const ENTRADAS_DE_PLATAFORMA = {
  'public-push-guard.js': 'gh pr create -R TYCON-SA/tycon-harness --title t --body b',
  'pr-one-per-repo-guard.js': 'az repos pr create --source-branch feat -r R1 -p P --org https://dev.azure.com/o',
  'pr-auto-complete-guard.js': 'gh pr merge 5 --merge',
};
const entradaDe = (f) => (f.entrada_en_la_prueba ? ENTRADAS_DE_PLATAFORMA[f.guion] : f.entrada_tipica);

/** Las variantes de entrada del renglón: dentro y fuera de su terreno para un crítico con terreno acotado. */
function variantesDe(f) {
  return f.clase === 'critico' && f.fuera_del_terreno ? { 'en su terreno': entradaDe(f), 'fuera de su terreno': f.fuera_del_terreno } : { 'entrada típica': entradaDe(f) };
}

test('T1 Policy_EveryBlockingRegistrationHasARow @story-8.159 @ac-1 @ac-2 — cada registro que frena tiene su renglón, con clase y sus campos', () => {
  const registros = LISTA.hooks.filter((h) => h.effect === 'blocks');
  const filas = new Map(POL.frenos.filter((f) => f.spec).map((f) => [claveDe(f), f]));
  for (const h of registros) {
    const f = filas.get(`${h.spec}\0${h.event}\0${h.matcher || ''}`);
    assert.ok(f, `${h.spec} (${h.event}, ${h.matcher || 'sin matcher'}) no tiene renglón en hook-failure-policy.json`);
    assert.ok(['critico', 'calidad', 'cierre'].includes(f.clase), `${h.spec}: clase «${f.clase}»`);
    if (f.clase === 'critico') assert.ok(f.terreno, `${h.spec}: un crítico declara su terreno`);
    for (const k of ['fail_closed_today', 'salidas_1_a_proposito', 'fuera_de_la_matriz']) assert.ok(Array.isArray(f[k]), `${h.spec}: ${k} es una lista`);
    assert.ok('reloj_propio_ms' in f && 'timeout_del_instalador' in f, `${h.spec}: dice su reloj y el timeout del instalador`);
    assert.strictEqual(f.timeout_del_instalador, h.timeout === undefined ? null : h.timeout, `${h.spec}: el timeout del renglón es el de la lista`);
    assert.deepStrictEqual(Boolean(f.plataformas && f.plataformas.windows), !(h.platforms && h.platforms.windows === false), `${h.spec}: las plataformas son las de la lista`);
    assert.ok(['codigo-2', 'deny', 'decision-block'].includes(f.como_frena), `${h.spec}: cómo frena`);
  }
  assert.strictEqual(POL.frenos.filter((f) => f.spec).length, registros.length, 'un renglón por registro, sin repetidos');
});

test('T2 Policy_RowWithoutRegistration_Fails_ExceptManagedSettings @story-8.159 @ac-2 — un renglón sin registro falla, salvo el de producción; otra historia y fuera de la matriz, con su suite', () => {
  const claves = new Set(LISTA.hooks.filter((h) => h.effect === 'blocks').map((h) => `${h.spec}\0${h.event}\0${h.matcher || ''}`));
  for (const f of POL.frenos) {
    if (f.origen === 'managed-settings') {
      assert.ok(fs.existsSync(path.join(ROOT, f.guion_repo)), `${f.guion}: su guion existe (${f.guion_repo})`);
      assert.ok(fs.existsSync(path.join(ROOT, f.lanzador_repo)), `${f.guion}: su lanzador existe (${f.lanzador_repo})`);
      continue;
    }
    assert.ok(claves.has(claveDe(f)), `${f.guion} (${f.evento}, ${f.matcher}): el renglón no corresponde a ningún registro que frena`);
  }
  for (const f of POL.frenos) {
    for (const [modo, o] of Object.entries(f.owner || {})) {
      assert.match(String(o.historia), /^\d+\.\d+$/, `${f.guion} · ${modo}: nombra la historia`);
      assert.ok(SUITES.includes(JSON.stringify(o.suite)), `${f.guion} · ${modo}: la suite de la ${o.historia} (${o.suite}) está en suites.json`);
    }
    for (const x of f.fuera_de_la_matriz) {
      assert.ok(x.motivo && x.dispara, `${f.guion} · ${x.camino}: dice qué lo dispara y por qué no está en la matriz`);
      assert.ok(SUITES.includes(JSON.stringify(x.suite)), `${f.guion} · ${x.camino}: su suite (${x.suite}) está en suites.json`);
    }
  }
});

test('T3 Matrix_EveryHookHasACasePerApplicableMode_TerrainVariants @story-8.159 @ac-3 @ac-5 — cada modo tiene su caso o su motivo, y cada camino que hoy frena, su caso', () => {
  for (const f of POL.frenos) {
    if (esDeOtraHistoria(f)) continue;
    for (const m of MODOS) {
      const corre = modosDe(f).includes(m);
      const motivo = (f.modos_que_no_aplican || {})[m] || (PROPIOS_DE_SHELL.has(m) && !f.guion.endsWith('.sh') ? 'propio de los de shell' : null);
      assert.ok(corre !== Boolean(motivo), `${f.guion} (${f.matcher}) · ${m}: o corre o declara por qué no`);
    }
    if (f.clase === 'critico') assert.ok(f.fuera_del_terreno || /todo comando/.test(f.terreno), `${f.guion}: un crítico con terreno acotado corre también fuera de él`);
    if (f.guion === 'public-push-guard.js') continue;
    for (const c of f.fail_closed_today) assert.ok(CASOS[f.guion] && CASOS[f.guion][c.camino], `${f.guion} · ${c.camino}: tiene su caso en la matriz`);
  }
});

const GIT_QUE_ESCRIBE = ['git reset --hard', 'git stash', 'git commit -am x', 'git checkout -- README.md'];

test('T4 Matrix_NotApplicableMode_IsDeclaredAndTrue_PerPlatform @story-8.159 @ac-6 — un freno sin git o sin ps decide igual con y sin ellos', (t) => {
  const L = HL.lab(t);
  const r = L.repo();
  for (const f of POL.frenos) {
    if (esDeOtraHistoria(f) || !enEstaPlataforma(f)) continue;
    for (const [m, faltan] of [['without-git', ['git']], ['without-ps', ['pgrep', 'ps']]]) {
      if (!(f.modos_que_no_aplican || {})[m] || /lo prueba su suite/.test(f.modos_que_no_aplican[m])) continue;
      // la entrada típica no llega a todas las ramas: un freno de la consola se prueba también con comandos de git que
      // escriben, sobre un repo con cambios
      const deLaConsola = f.evento === 'PreToolUse' && /Bash/.test(f.matcher);
      for (const entrada of [...Object.values(variantesDe(f)), ...(deLaConsola ? GIT_QUE_ESCRIBE : [])]) {
        const { json } = eventoDe(f, entrada, r.dir);
        const con = HL.resultado(L.correr(guionDe(f), json, { extra: { ...(f.encendido || {}) }, cwd: r.dir }));
        const sin = HL.resultado(L.correr(guionDe(f), json, { extra: { ...(f.encendido || {}) }, cwd: r.dir, PATH: L.pathSin(faltan) }));
        assert.strictEqual(sin, con, `${f.guion} (${f.matcher}) · ${m}: declara que no lo usa, y sin ${faltan.join(' ni ')} decide distinto (${con} → ${sin})`);
      }
    }
  }
});

// lo que mira T10: los registros de la casa de la cuenta. Otras sesiones de la máquina los escriben mientras corre la
// matriz, así que no se compara el tamaño: se lee sólo lo que se agregó y se busca la sesión y la carpeta de esta corrida
const casaReal = os.userInfo().homedir;
const REGISTROS_REALES = ['.claude/.tycon-pipeline/hook-errors.log', '.claude/.tycon-pipeline/gates.log', '.tycon/state/hook-errors.log', '.tycon/state/gates.log'].map((r) => path.join(casaReal, r));
const tamanos = () => new Map(REGISTROS_REALES.map((p) => { try { return [p, fs.statSync(p).size]; } catch (_) { return [p, 0]; } }));
function agregadoDesde(antes) {
  return REGISTROS_REALES.map((p) => {
    try {
      const desde = antes.get(p) || 0;
      const largo = fs.statSync(p).size - desde;
      if (largo <= 0) return '';
      const fd = fs.openSync(p, 'r');
      const buf = Buffer.alloc(largo);
      fs.readSync(fd, buf, 0, largo, desde);
      fs.closeSync(fd);
      return buf.toString('utf8');
    } catch (_) { return ''; }
  }).join('\n');
}
// la sesión de los eventos de la medición: propia de esta corrida, para encontrarla si se escapa a la casa real
const SID_DE_LA_MEDICION = `hfm-${process.pid}-${Date.now().toString(36)}`; // stable-data: sólo identifica la corrida

test('T5 T10 Matrix_MeasureMode_WritesTodayTable_RunsIsolated @story-8.159 @ac-4 @ac-5 — mide cada freno con cada modo, escribe la tabla de hoy y no toca la casa real', (t) => {
  const antes = tamanos();
  const L = HL.lab(t);
  const r = L.repo();
  // stable-data: la hora de la tabla medida sólo la fecha; ninguna prueba la compara
  const tabla = { ts: new Date().toISOString(), plataforma: process.platform, nota: 'frena = sale 2, niega o retiene el turno; pasa = sale 0; un número es otro código', frenos: [] };
  for (const f of POL.frenos) {
    const fila = { guion: f.guion, evento: f.evento, matcher: f.matcher, clase: f.clase, modos: {} };
    if (esDeOtraHistoria(f)) fila.no_medido = `lo mide la historia ${f.owner.todos.historia}`;
    else if (!enEstaPlataforma(f)) fila.no_medido = 'no se instala en esta plataforma';
    else {
      // sin falla: lo que decide con la entrada típica, para leer cada modo contra su decisión normal
      fila.sano = {};
      for (const [variante, entrada] of Object.entries(variantesDe(f))) {
        const { json } = eventoDe(f, entrada, r.dir);
        fila.sano[variante] = HL.resultado(L.correr(guionDe(f), json, { extra: { ...(f.encendido || {}) }, cwd: r.dir }));
      }
      for (const m of modosDe(f)) {
        fila.modos[m] = {};
        for (const [variante, entrada] of Object.entries(variantesDe(f))) fila.modos[m][variante] = correrModo(L, f, m, entrada, r.dir);
      }
    }
    tabla.frenos.push(fila);
  }
  for (const fila of tabla.frenos) {
    if (fila.no_medido) continue;
    for (const [m, vs] of Object.entries(fila.modos)) for (const [v, res] of Object.entries(vs)) assert.ok(res, `${fila.guion} · ${m} · ${v}: tiene resultado`);
  }
  const out = process.env.TYCON_HOOK_MATRIX_OUT || path.join(L.dir, 'hook-failure-today.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(tabla, null, 2)}\n`);
  assert.ok(JSON.parse(fs.readFileSync(out, 'utf8')).frenos.length === POL.frenos.length, 'la tabla trae un renglón por freno');
  const agregado = agregadoDesde(antes);
  assert.ok(!agregado.includes(SID_DE_LA_MEDICION) && !agregado.includes(L.dir), 'la matriz no escribió en los registros de la casa real');
});

test('T11 Matrix_FailClosedToday_EveryPathStillBlocks_TheOtherHooks @story-8.159 @ac-7 — cada camino que hoy frena al fallar sigue frenando', (t) => {
  for (const f of POL.frenos) {
    if (f.guion === 'public-push-guard.js' || esDeOtraHistoria(f) || !enEstaPlataforma(f)) continue;
    for (const c of f.fail_closed_today) {
      const L = HL.lab(t);
      for (const res of [].concat(CASOS[f.guion][c.camino](L))) {
        assert.strictEqual(HL.resultado(res), 'frena', `${f.guion} · ${c.camino}: frena (${(res.err || res.out).replace(/\s+/g, ' ').slice(0, 200)})`);
      }
      // el mismo escenario sin la falla deja pasar: el caso frena por la falla, no por la decisión normal
      const ctl = (CONTROLES[f.guion] || {})[c.camino];
      assert.ok(ctl, `${f.guion} · ${c.camino}: tiene su control sin la falla`);
      const sana = ctl(HL.lab(t));
      assert.strictEqual(HL.resultado(sana), 'pasa', `${f.guion} · ${c.camino}: sin la falla deja pasar (${(sana.err || sana.out).replace(/\s+/g, ' ').slice(0, 200)})`);
    }
  }
});

// ── La medición en vivo de cada herramienta (live-fire.js --failure-modes) ───────────────────────────────────────────

const LF = require('../controls-bench/live-fire.js');

test('T8 LiveFire_ToolMissingOrNoMark_SaysNotMeasured @story-8.159 @ac-8 @ac-9 — sin la marca del gancho dice NO MEDIDO; con las marcas distingue pasa, frena y cortado', (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lf-marcas-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // sin ninguna marca: ningún modo se midió, y ninguno dice «pasa» ni «frena»
  for (const [modo, v] of Object.entries(LF.failureVerdicts(dir, ''))) {
    assert.match(v.veredicto, /^NO MEDIDO/, `${modo}: sin la marca del gancho no se mide`);
  }
  const marca = (n, ms) => fs.writeFileSync(path.join(dir, n), String(ms));
  marca('gancho-exit1-inicio', 1000); marca('gancho-exit1-comando', 1500);
  marca('gancho-exit127-inicio', 2000);
  marca('gancho-stall-inicio', 3000); marca('gancho-stall-comando', 8000);
  const v = LF.failureVerdicts(dir, 'E3AVISO-uno');
  assert.deepStrictEqual([v.exit1.veredicto, v.exit1.aviso, v.exit1.ms], ['pasa', true, 500], 'el gancho corrió y el comando también');
  assert.deepStrictEqual([v.exit127.veredicto, v.exit127.aviso], ['frena', false], 'el gancho corrió y el comando no');
  assert.deepStrictEqual([v.stall.veredicto, v.stall.cortado], ['pasa', true], 'sin la marca del final, la herramienta lo cortó');
  marca('gancho-stall-fin', 7000);
  assert.strictEqual(LF.failureVerdicts(dir, '').stall.cortado, false, 'con la marca del final antes del comando, la herramienta esperó');
});

test('T9 LiveFire_CodexWithoutTimeoutField_IsWritten @story-8.159 @ac-10 — el gancho de prueba trae su timeout, y el inventario dice si cada herramienta lo respeta', () => {
  const reg = LF.buildFailureHooksConfig('/x/falla.js', { platform: 'darwin', execPath: '/n/node' });
  assert.strictEqual(reg.PreToolUse[0].hooks[0].timeout, LF.FALLA_TIMEOUT_S, 'el gancho que se cuelga lleva un timeout');
  assert.ok(reg.PostToolUse[0].hooks[0].command.endsWith(' despues'), 'el gancho después de la consola marca el comando');
  const inv = fs.readFileSync(path.join(ROOT, 'guides', 'maintaining', 'codex-divergence-inventory.md'), 'utf8');
  const seccion = inv.slice(inv.indexOf('<!-- modos-de-falla -->'));
  assert.ok(inv.includes('<!-- modos-de-falla -->'), 'el inventario tiene la sección de los modos de falla');
  for (const tool of ['Claude Code', 'Codex']) {
    assert.match(seccion, new RegExp(`${tool}[^\\n]*\\|[^\\n]*timeout`, 'i'), `el inventario dice si ${tool} respeta el timeout de un gancho`);
  }
  assert.match(seccion, /live-fire\.js --tool (claude|codex) --failure-modes/, 'el inventario nombra el comando que lo midió');
  assert.match(seccion, /\d{4}-\d{2}-\d{2}/, 'con fecha');
});
