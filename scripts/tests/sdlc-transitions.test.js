'use strict';
/**
 * sdlc-transitions.test.js — red de la derivación de transiciones de estado desde git
 * Fixture determinista: repos git efímeros con commits retro-fechados
 * (`GIT_AUTHOR_DATE`), igual molde que sdlc-stage-metrics.test.js. Fuerza el descubridor de
 * FALLBACK (`TYCON_SKILLS_DIR` inexistente) para no depender de agent-skills.
 *
 * 🔴 REGLA DE ADMISIÓN: cada caso trae escrita, en su comentario, la MUTACIÓN que lo pone en
 *    rojo. Un caso que no sabe ponerse rojo no vale — el precedente lo pagó este repo con un
 *    chequeo que buscaba un texto que la línea de resumen imprime siempre.
 *
 * Lo que cuida, en una frase: que la serie salga del historial REAL (no del archivo actual),
 * que un commit que no cambia el estado no invente una transición, que un renombre no parta la
 * serie, que una etapa saltada NO reciba 0, y que todo "no pude" sea distinguible de
 * "medí y no hay".
 *
 * Spawnea git → va en el throttle DIARIO del instalador, no en UNIT_TESTS de cada arranque.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// 🔴 ANTES del require: el módulo resuelve el descubridor canónico al CARGARSE. Se fuerza el de
//    respaldo porque el canónico descarta ids que no tienen forma de trabajo (`T-1` se parece a
//    `EV-1`, que es material de evaluación, no backlog) — y los fixtures usan justamente esos.
//    Sin esto los casos que llaman a measureRepo en proceso miden un repo de cero stories y el
//    verde no significaría nada.
const SIN_DESCUBRIDOR = { TYCON_SKILLS_DIR: path.join(os.tmpdir(), 'no-existe-agent-skills') };
process.env.TYCON_SKILLS_DIR = SIN_DESCUBRIDOR.TYCON_SKILLS_DIR;

const M = require('../metrics/sdlc-stage-metrics.js');
const ESTADOS_PATH = path.resolve(__dirname, '..', 'metrics', 'states.json');

function sh(cwd, cmd, args, env = {}) {
  return execFileSync(cmd, args, {
    cwd, encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', ...env },
  });
}

function commit(repo, msg, isoDate) {
  sh(repo, 'git', ['add', '-A']);
  sh(repo, 'git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', msg], {
    GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate,
  });
}

function story(id, status, cuerpo = '') {
  return `---\nstory: ${id}\nepic: 1\nstatus: ${status}\n---\n\n# Story ${id}\n${cuerpo}`;
}

function nuevoRepo(nombre) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `sdlc-trans-${nombre}-`));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  sh(root, 'git', ['init', '-q', 'repo']);
  return { root, repo };
}

const escribir = (repo, rel, txt) => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), txt);
};

/** Las stories "actuales" que el medidor le pasaría a la derivación. */
function storiesActuales(repo) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) {
        const fm = M.readFrontmatter(p);
        if (fm && fm.id) out.push({ file: p, id: fm.id });
      }
    }
  };
  walk(repo);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Fixture grande: una sola historia git que cubre T1, T2, T3, T4, T6, T7, T9 y T17.
// ─────────────────────────────────────────────────────────────────────────────────────────────

function fixturePrincipal() {
  const { root, repo } = nuevoRepo('main');
  const d = (n) => {
    // fechas relativas a HOY para que T17 (retroactividad) no dependa del calendario
    const t = new Date(Date.now() - n * 86400000);
    return t.toISOString().replace('.000Z', '-00:00').replace(/\.\d+Z$/, '-00:00');
  };

  // A-1 — el caso canónico: 5 commits, 4 transiciones, fechas distintas. Arranca hace 120 días
  //       (T17: la serie NO puede empezar el día de la corrida).
  escribir(repo, 'specs/story-a.md', story('A-1', 'draft'));
  // B-1 — nace done y se toca 3 veces sin cambiar de estado (T2).
  escribir(repo, 'specs/story-b.md', story('B-1', 'done'));
  // C-1 — se le cambia el título, no el estado (T3).
  escribir(repo, 'specs/story-c.md', story('C-1', 'ready-for-dev'));
  // D-1 — salta in-progress: ready-for-dev → done directo (T7).
  escribir(repo, 'specs/story-d.md', story('D-1', 'ready-for-dev'));
  // E-1 — estados fuera del diccionario y alias (T9).
  escribir(repo, 'specs/story-e.md', story('E-1', 'vigente'));
  // F-1 — se muda de carpeta entre dos cambios de estado (T4).
  escribir(repo, 'specs/story-f.md', story('F-1', 'draft'));
  commit(repo, 'nacen las stories', d(120));

  escribir(repo, 'specs/story-a.md', story('A-1', 'ready-for-dev'));
  escribir(repo, 'specs/story-f.md', story('F-1', 'ready-for-dev'));
  commit(repo, 'A y F pasan a ready-for-dev', d(118));

  // A-1 entra a in-progress. G-1 (segunda story con etapa in-progress, para el n=2 de T6).
  escribir(repo, 'specs/story-a.md', story('A-1', 'in-progress'));
  escribir(repo, 'specs/story-g.md', story('G-1', 'ready-for-dev'));
  commit(repo, 'A a in-progress', d(110));

  // Commit que toca A pero NO su estado (T3 sobre C, y de paso sobre A).
  escribir(repo, 'specs/story-a.md', story('A-1', 'in-progress', '\nun párrafo nuevo\n'));
  escribir(repo, 'specs/story-c.md', story('C-1', 'ready-for-dev', '\notro título\n'));
  commit(repo, 'sólo texto: ni A ni C cambian de estado', d(109));

  // A sale de in-progress a los 8 días (110 → 102). G entra y sale a los 4 (108 → 104).
  escribir(repo, 'specs/story-g.md', story('G-1', 'in-progress'));
  commit(repo, 'G a in-progress', d(108));

  escribir(repo, 'specs/story-g.md', story('G-1', 'review'));
  commit(repo, 'G a review', d(104));

  escribir(repo, 'specs/story-a.md', story('A-1', 'review'));
  commit(repo, 'A a review', d(102));

  // El renombre de F: se muda de carpeta SIN cambiar de estado.
  fs.mkdirSync(path.join(repo, 'docs', 'historias'), { recursive: true });
  sh(repo, 'git', ['mv', 'specs/story-f.md', 'docs/historias/story-f.md']);
  commit(repo, 'F se muda de carpeta', d(100));

  // Segunda transición de F, ya en la carpeta nueva (T4: la serie tiene las DOS).
  escribir(repo, 'docs/historias/story-f.md', story('F-1', 'in-progress'));
  commit(repo, 'F a in-progress después de mudarse', d(98));

  escribir(repo, 'specs/story-a.md', story('A-1', 'done'));
  escribir(repo, 'specs/story-d.md', story('D-1', 'done'));
  escribir(repo, 'specs/story-e.md', story('E-1', 'whatever'));
  escribir(repo, 'specs/story-b.md', story('B-1', 'done', '\nse toca sin cambiar de estado\n'));
  commit(repo, 'cierres', d(96));

  escribir(repo, 'specs/story-b.md', story('B-1', 'done', '\ny otra vez\n'));
  commit(repo, 'B se toca por tercera vez', d(95));

  return { root, repo };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────

test('T14 · los estados del diccionario son los medidos (alias → canónico existente, sin huérfanos)', () => {
  // 🔴 rojo: un alias que apunte a un canónico inexistente.
  //
  // 🔴 Este caso cuida que cada alias apunte a un canónico existente, que ningún estado tenga doble rol y que los seis
  //    canónicos originales sigan; además exige la lista de canónicos del diccionario completo. La validación
  //    exhaustiva del diccionario vive en `states-dictionary.test.js`.
  const dict = JSON.parse(fs.readFileSync(ESTADOS_PATH, 'utf8'));
  assert.ok(Array.isArray(dict.canonical) && dict.canonical.length, 'canonical tiene que ser una lista no vacía');
  for (const c of ['draft', 'backlog', 'ready-for-dev', 'in-progress', 'review', 'done']) {
    assert.ok(dict.canonical.includes(c), `falta el canónico ${c} (los seis de la 2.1 no se van)`);
  }
  for (const c of ['blocked', 'cancelled', 'abandoned', 'superseded', 'reverted']) {
    assert.ok(dict.canonical.includes(c), `falta el canónico ${c} que agregó la 2.2`);
  }
  for (const [alias, destino] of Object.entries(dict.alias || {})) {
    assert.ok(dict.canonical.includes(destino), `el alias ${alias} apunta a ${destino}, que no es canónico`);
    assert.ok(!dict.canonical.includes(alias), `${alias} está como alias y como canónico a la vez`);
  }
  for (const [a, c] of Object.entries({ implemented: 'done', complete: 'done', completed: 'done',
    closed: 'done', approved: 'ready-for-dev', pending: 'backlog', vigente: 'done' })) {
    assert.equal(dict.alias[a], c, `el alias ya visto ${a} tiene que mapear a ${c}`);
  }
  // 🔴 Los terminales que NO son una entrega no pueden caer en `cerrado`: es la trampa central
  //    del criterio de «cerrado» (inflaría done_total y movería rework y dod, que se calculan sobre cerradas).
  for (const t of ['cancelled', 'abandoned', 'superseded', 'reverted']) {
    assert.ok(!dict.groups.cerrado.includes(t), `${t} terminó sin entregarse: no puede estar en groups.cerrado`);
  }
});

test('T5 · usa el MISMO regex del frontmatter (comentario inline con comillas no rompe la lectura)', () => {
  // 🔴 rojo: un regex propio que no excluya `#` → devuelve "review  # ver 'notas'".
  const texto = "---\nstory: X-1\nstatus: review  # ver 'notas'\n---\n\n# X\n";
  const fm = M.parseFrontmatter(texto);
  assert.equal(fm.status, 'review');
  assert.equal(fm.id, 'X-1');
  // y el mismo parser sobre un archivo real tiene que dar lo mismo (una sola fuente)
  const { repo } = nuevoRepo('regex');
  escribir(repo, 'specs/x.md', texto);
  assert.deepEqual(
    { id: M.readFrontmatter(path.join(repo, 'specs', 'x.md')).id, status: M.readFrontmatter(path.join(repo, 'specs', 'x.md')).status },
    { id: 'X-1', status: 'review' });
});

test('T1 · deriva las cuatro transiciones con la fecha de autor de cada commit, en orden', () => {
  // 🔴 rojo: leer sólo el archivo actual (sin recorrer el historial) → 0 transiciones.
  const { repo } = fixturePrincipal();
  const r = M.derivarTransiciones(repo, storiesActuales(repo), SIN_DESCUBRIDOR);
  const a = r.transiciones['A-1'];
  assert.ok(a, 'A-1 tiene que tener serie');
  assert.equal(a.length, 4, `esperaba 4 transiciones y hubo ${a.length}`);
  assert.deepEqual(a.map((t) => `${t.de}→${t.a}`),
    ['draft→ready-for-dev', 'ready-for-dev→in-progress', 'in-progress→review', 'review→done']);
  for (const t of a) {
    assert.match(t.fecha, /^\d{4}-\d{2}-\d{2}T/, 'la fecha tiene que ser ISO de autor (%aI)');
    assert.match(t.commit, /^[0-9a-f]{7,40}$/, 'cada transición cita su commit');
  }
  const fechas = a.map((t) => Date.parse(t.fecha));
  assert.deepEqual(fechas, [...fechas].sort((x, y) => x - y), 'las transiciones salen en orden cronológico');
});

test('T17 · la derivación es retroactiva: conserva las fechas viejas, no arranca hoy', () => {
  // 🔴 rojo: usar la fecha del commit actual (o `new Date()`) en vez de %aI de cada commit.
  const { repo } = fixturePrincipal();
  const r = M.derivarTransiciones(repo, storiesActuales(repo), SIN_DESCUBRIDOR);
  const primera = r.transiciones['A-1'][0];
  const diasAtras = (Date.now() - Date.parse(primera.fecha)) / 86400000;
  assert.ok(diasAtras > 100, `la transición más vieja tiene que ser de hace >100 días y fue de hace ${diasAtras.toFixed(1)}`);
});

test('T2 · una story sin cambios de estado da cero transiciones y NO desaparece del denominador', () => {
  // 🔴 rojo: filtrar las stories sin transiciones antes de contar → B-1 se evapora.
  const { repo } = fixturePrincipal();
  const stories = storiesActuales(repo);
  const r = M.derivarTransiciones(repo, stories, SIN_DESCUBRIDOR);
  assert.deepEqual(r.transiciones['B-1'] || [], [], 'B-1 no cambió de estado nunca');
  assert.ok(r.sinTransiciones >= 2, `B-1 y C-1 tienen que contar como sin_transiciones (fueron ${r.sinTransiciones})`);
  assert.equal(r.medidas + r.sinTransiciones, stories.length,
    'medidas + sin_transiciones tiene que dar el total de stories: nadie sale del denominador');
});

test('T3 · un commit que toca el archivo pero no la línea status NO es una transición', () => {
  // 🔴 rojo: contar cada commit que toca el archivo → aparece una transición fantasma.
  const { repo } = fixturePrincipal();
  const r = M.derivarTransiciones(repo, storiesActuales(repo), SIN_DESCUBRIDOR);
  assert.deepEqual(r.transiciones['C-1'] || [], [],
    'C-1 se tocó (cambió el título) pero su estado nunca cambió');
  // A-1 también se tocó sin cambiar de estado, y sigue teniendo exactamente 4
  assert.equal(r.transiciones['A-1'].length, 4);
});

test('T4 · sobrevive al renombre: la serie sigue completa después de un git mv', () => {
  // 🔴 rojo: agrupar la serie por la RUTA del archivo en vez de por el `story:` declarado →
  //    se pierde la transición anterior a la mudanza (queda 1 de 2).
  const { repo } = fixturePrincipal();
  const r = M.derivarTransiciones(repo, storiesActuales(repo), SIN_DESCUBRIDOR);
  const f = r.transiciones['F-1'];
  assert.ok(f, 'F-1 tiene que tener serie aunque se haya mudado de carpeta');
  assert.equal(f.length, 2, `esperaba las 2 transiciones de F-1 y hubo ${f.length}`);
  assert.deepEqual(f.map((t) => `${t.de}→${t.a}`), ['draft→ready-for-dev', 'ready-for-dev→in-progress']);
});

test('T9 · un estado desconocido se publica; los alias ya vistos mapean al canónico', () => {
  // 🔴 rojo: `if (!DICT[s]) continue` → "whatever" desaparece sin dejar rastro.
  const { repo } = fixturePrincipal();
  const r = M.derivarTransiciones(repo, storiesActuales(repo), SIN_DESCUBRIDOR);
  const e = r.transiciones['E-1'];
  assert.equal(e.length, 1, 'E-1 pasó de vigente a whatever: una transición');
  assert.equal(e[0].de, 'done', '`vigente` es alias de `done`');
  assert.equal(e[0].a, 'desconocido:whatever', 'lo que no está en el diccionario se marca, no se descarta');
  assert.equal(r.desconocidos.whatever, 1, 'y se publica con su cuenta');
  assert.ok(!('vigente' in r.desconocidos), '`vigente` tiene alias: no es desconocido');
});

test('T6 · tiempo por etapa: mediana y n por etapa, por story', () => {
  // 🔴 rojo: sumar todas las duraciones en vez de medir por story → el `n` sale mal.
  const { repo } = fixturePrincipal();
  const r = M.derivarTransiciones(repo, storiesActuales(repo), SIN_DESCUBRIDOR);
  const t = M.tiempoPorEtapa(r.transiciones);
  const ip = t['in-progress'];
  assert.ok(ip, 'tiene que haber etapa in-progress');
  assert.equal(ip.n, 2, `in-progress lo recorrieron A-1 (8 d) y G-1 (4 d): n=2, y fue ${ip.n}`);
  assert.equal(Math.round(ip.min), 4);
  assert.equal(Math.round(ip.max), 8);
  assert.equal(Math.round(ip.median), 6);
  // La etapa se define como transición-de-entrada → transición-de-salida. Una story que
  // NACIÓ en la etapa (D-1 y G-1 nacen ready-for-dev) no tiene transición de entrada, así que
  // no se le puede medir esa etapa — y no se le inventa un comienzo.
  const rfd = t['ready-for-dev'];
  assert.equal(rfd.n, 2, `ready-for-dev sólo lo ENTRARON A-1 (8 d) y F-1 (20 d): n=2, y fue ${rfd.n}`);
  assert.equal(Math.round(rfd.min), 8);
  assert.equal(Math.round(rfd.max), 20);
});

test('T7 · una etapa saltada NO recibe 0: esa story no entra en el n de esa etapa', () => {
  // 🔴 rojo: imputar 0 a la etapa saltada → in-progress pasaría a n=3 con un 0 que baja la mediana.
  const { repo } = fixturePrincipal();
  const r = M.derivarTransiciones(repo, storiesActuales(repo), SIN_DESCUBRIDOR);
  // D-1 pasó ready-for-dev → done sin pisar in-progress
  assert.deepEqual(r.transiciones['D-1'].map((x) => `${x.de}→${x.a}`), ['ready-for-dev→done']);
  const t = M.tiempoPorEtapa(r.transiciones);
  assert.equal(t['in-progress'].n, 2, 'D-1 NO puede aparecer en el n de in-progress');
  for (const [etapa, s] of Object.entries(t)) {
    assert.ok(s.min > 0, `ninguna etapa puede traer un 0 imputado (${etapa} trajo min=${s.min})`);
  }
});

test('T8 · con el presupuesto agotado sale NO MEDIDO con el motivo, y el proceso termina', () => {
  // 🔴 rojo: quitar el presupuesto → o no termina, o publica una serie parcial como si fuera completa.
  const { repo } = fixturePrincipal();
  const stories = storiesActuales(repo);
  const r = M.derivarTransiciones(repo, stories, { ...SIN_DESCUBRIDOR, budgetMs: 1 });
  assert.ok(r.agotado, 'con 1 ms de presupuesto tiene que declararse agotado');
  assert.match(r.motivo || '', /presupuesto de tiempo agotado/,
    'el motivo se escribe en castellano y dice qué pasó');
  assert.match(r.motivo || '', /\d+ stories de \d+/, 'el motivo dice cuántas alcanzó a mirar de cuántas');
  const m = M.measureRepo(repo, null, { budgetMs: 1 });
  assert.equal(m.tiempoPorEtapa, null, 'presupuesto agotado ⇒ tiempo_por_etapa null, jamás {} ni 0');
  assert.ok((m.notMeasured || []).some((x) => /transiciones: presupuesto de tiempo agotado/.test(x)),
    `not_measured tiene que nombrarlo y trajo: ${JSON.stringify(m.notMeasured)}`);
});

test('T12 · las cuatro métricas existentes no cambian', () => {
  // 🔴 rojo: reutilizar la lista de stories filtrada por transiciones para el lead time → cambia el n.
  const { root, repo } = nuevoRepo('nocambia');
  escribir(repo, 'specs/story-t1.md',
    '---\nstory: T-1\nepic: 1\nstatus: ready-for-dev\nfollowed_up_by:\n  - id: T-9\n---\n\n# T-1\n');
  escribir(repo, 'specs/story-t2.md', '---\nstory: T-2\nepic: 1\nstatus: done\ndod_runtime_exempt: true\n---\n\n# T-2\n');
  escribir(repo, 'specs/story-t3.md', story('T-3', 'done'));
  escribir(repo, 'specs/story-t4.md', story('T-4', 'in-progress'));
  commit(repo, 'nacen', '2026-08-01T10:00:00-03:00');
  escribir(repo, 'specs/story-t1.md',
    '---\nstory: T-1\nepic: 1\nstatus: done\nfollowed_up_by:\n  - id: T-9\n---\n\n# T-1\n');
  commit(repo, 'T-1 cierra 10 días después', '2026-08-11T10:00:00-03:00');
  fs.mkdirSync(path.join(repo, '.advisors', 'dod-runtime'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.advisors', 'dod-runtime', 'T-1-dod-runtime-checker.md'), 'AC #1 ✅\n');
  commit(repo, 'evidencia', '2026-08-11T11:00:00-03:00');

  const m = M.measureRepo(repo, null, SIN_DESCUBRIDOR);
  assert.equal(m.storiesTotal, 4, 'las 4 stories siguen contando');
  assert.equal(m.doneTotal, 3);
  const lt = M.stats(m.leads.map((l) => l.days));
  assert.equal(lt.n, 3, 'el lead time sigue midiendo las 3 done');
  assert.equal(Math.round(lt.max), 10, 'T-1 sigue dando 10 días');
  assert.deepEqual(m.rework, { num: 1, den: 3 });
  // La exención no cuenta como evidencia (sale del cociente y va en `exentas`). Este caso cuida que las
  // transiciones no alteran el número: la regla la fija el medidor.
  assert.deepEqual(m.dod, { num: 1, den: 2, exentas: 1 }, 'T-1 por archivo; T-2 exenta, fuera del cociente');
  assert.ok(root);
});

/**
 * Monta un clon liviano igual al del nocturno: `--filter=blob:none --no-checkout` y después
 * sparse-checkout de los `.md`. Es la forma exacta de `pipelines/azure-pipelines.yml:75-93`, y la única
 * en la que `traerBlobs` llega a correr — en un clon común el contenido ya está local.
 * Sin red: el remoto es un `file://` con `uploadpack.allowfilter` prendido.
 */
function clonLiviano(nombre, commits) {
  const { root, repo: origen } = nuevoRepo(nombre);
  for (const [txt, rel, fecha, msg] of commits) { escribir(origen, rel, txt); commit(origen, msg, fecha); }
  sh(origen, 'git', ['config', 'uploadpack.allowfilter', 'true']);
  sh(origen, 'git', ['config', 'uploadpack.allowanysha1inwant', 'true']);
  const clon = path.join(root, 'clon');
  sh(root, 'git', ['clone', '--quiet', '--filter=blob:none', '--no-checkout', `file://${origen}`, clon]);
  fs.writeFileSync(path.join(clon, '.git', 'info', 'sparse-checkout'), '**/*.md\n');
  sh(clon, 'git', ['sparse-checkout', 'init', '--no-cone']);
  sh(clon, 'git', ['checkout', '--quiet']);
  return { root, origen, clon };
}

test('T19 · el camino del clon PARCIAL: baja los blobs por lote y arma la serie completa', () => {
  // 🔴 rojo: quitar el `if (parcial) traerBlobs(...)` → los blobs históricos no están, la story
  //    cae entera en `storiesFaltantes` y no hay ni una serie. Éste es EL camino que corre en el
  //    nocturno todas las noches y el único que los otros casos no tocaban: sus fixtures son
  //    clones comunes, donde el contenido ya está local y `traerBlobs` nunca se llama.
  const { clon } = clonLiviano('parcial', [
    [story('P-1', 'draft'), 'specs/story-p.md', '2026-04-01T10:00:00-00:00', 'nace'],
    [story('P-1', 'in-progress'), 'specs/story-p.md', '2026-04-03T10:00:00-00:00', 'a in-progress'],
    [story('P-1', 'review'), 'specs/story-p.md', '2026-04-08T10:00:00-00:00', 'a review'],
  ]);
  assert.ok(M.esClonParcial(clon), 'el fixture tiene que SER un clon parcial, si no no prueba nada');

  const stories = storiesActuales(clon);
  assert.equal(stories.length, 1, 'el sparse-checkout tiene que haber traído la story actual');

  const r = M.derivarTransiciones(clon, stories, { loteBlobs: 2 });
  assert.deepEqual(r.storiesFaltantes, [], 'con el remoto accesible no puede faltar ninguna versión');
  assert.deepEqual((r.transiciones['P-1'] || []).map((t) => `${t.de}→${t.a}`),
    ['draft→in-progress', 'in-progress→review']);
  const t = M.tiempoPorEtapa(r.transiciones);
  assert.equal(Math.round(t['in-progress'].median), 5, 'del 3 al 8 de abril: 5 días');
});

test('T20 · un clon parcial SIN acceso al remoto no miente: "no pude" ≠ "medí y no hay"', () => {
  // 🔴 rojo: tratar un blob ausente como "esa versión no dice nada" y seguir → sale media serie
  //    publicada como si fuera entera. Es el fallo silencioso de manual, y acá el escenario es
  //    real: la versión ACTUAL está local (la trajo el sparse-checkout) pero las viejas no.
  const { origen, clon } = clonLiviano('huerfano', [
    [story('H-1', 'draft'), 'specs/story-h.md', '2026-04-01T10:00:00-00:00', 'nace'],
    [story('H-1', 'in-progress'), 'specs/story-h.md', '2026-04-03T10:00:00-00:00', 'a in-progress'],
  ]);
  fs.renameSync(origen, `${origen}-mudado`);   // el remoto se cae: las versiones viejas quedan inalcanzables

  const stories = storiesActuales(clon);
  const r = M.derivarTransiciones(clon, stories, {});
  assert.deepEqual(r.transiciones, {}, 'sin poder leer todas las versiones NO se publica media serie');
  assert.deepEqual(r.storiesFaltantes, ['H-1'], 'la story se nombra como no leída');
  assert.equal(r.sinTransiciones, 0, 'y NO se cuenta como "no cambió de estado", que sería mentira');
  assert.match(r.motivo || '', /versiones no descargables/, 'el motivo lo dice en castellano');

  const m = M.measureRepo(clon, null, {});
  assert.equal(m.tiempoPorEtapa, null, 'el repo sale no medido, nunca con un número parcial');
  assert.equal(m.storiesSinHistorial, 1, 'y la story queda contada aparte, no perdida');
  assert.ok((m.notMeasured || []).some((x) => /versiones no descargables/.test(x)),
    `not_measured tiene que nombrarlo y trajo: ${JSON.stringify(m.notMeasured)}`);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Defectos que fallan en SILENCIO: cada caso reproduce uno.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('T21 · dos commits con la MISMA fecha de autor no invierten la serie', () => {
  // 🔴 rojo: desempatar por el sha (`a.sha.localeCompare(b.sha)`), que no tiene ninguna relación
  //    con el orden causal. Con el sha "equivocado" la serie sale AL REVÉS y aparece una
  //    transición que nunca ocurrió (`review→in-progress`). Sin error, sin aviso.
  //    El orden correcto ya lo da git gratis: se conserva el del log topológico.
  const F = '2026-05-05T12:00:00-00:00';           // los dos commits, el MISMO segundo
  let invertidas = 0;
  for (let intento = 0; intento < 6; intento++) {  // varios shas hasta cubrir el orden adverso
    const { repo } = nuevoRepo(`empate-${intento}`);
    escribir(repo, 'specs/story-t.md', story('TIE-1', 'draft'));       commit(repo, 'nace', '2026-05-01T10:00:00-00:00');
    escribir(repo, 'specs/story-t.md', story('TIE-1', 'in-progress')); commit(repo, `a ip ${intento}`, F);
    escribir(repo, 'specs/story-t.md', story('TIE-1', 'review'));      commit(repo, `a review ${intento}`, F);
    const r = M.derivarTransiciones(repo, storiesActuales(repo), {});
    const serie = (r.transiciones['TIE-1'] || []).map((t) => `${t.de}→${t.a}`);
    assert.deepEqual(serie, ['draft→in-progress', 'in-progress→review'],
      `la historia real es draft→in-progress→review y salió ${JSON.stringify(serie)}`);
    if (serie.includes('review→in-progress')) invertidas++;
  }
  assert.equal(invertidas, 0);
});

test('T22 · dos archivos con el MISMO `story:` no se fusionan en una serie inventada', () => {
  // 🔴 rojo: agrupar por id sin chequear que las versiones vengan del mismo archivo → los dos
  //    historiales se intercalan por fecha y aparecen transiciones que no ocurrieron en ninguno
  //    de los dos; además una de las dos stories se lee como "no cambió de estado", que es falso.
  const { repo } = nuevoRepo('duplicado');
  escribir(repo, 'specs/dup-a.md', story('DUP-1', 'draft'));
  escribir(repo, 'specs/dup-b.md', story('DUP-1', 'backlog'));
  commit(repo, 'nacen las dos con el mismo id', '2026-05-01T10:00:00-00:00');
  escribir(repo, 'specs/dup-a.md', story('DUP-1', 'in-progress'));
  commit(repo, 'A a in-progress', '2026-05-03T10:00:00-00:00');
  escribir(repo, 'specs/dup-b.md', story('DUP-1', 'done'));
  commit(repo, 'B a done', '2026-05-05T10:00:00-00:00');

  const stories = storiesActuales(repo);
  assert.equal(stories.length, 2, 'el fixture tiene DOS archivos con el mismo id');
  const r = M.derivarTransiciones(repo, stories, {});
  assert.deepEqual(r.transiciones, {}, 'con el id ambiguo NO se publica ninguna serie fabricada');
  assert.deepEqual(r.idsDuplicados, ['DUP-1'], 'el id duplicado se nombra');
  assert.equal(r.sinTransiciones, 0, 'y NO se cuentan como "no cambiaron de estado"');
  assert.match(r.motivo || '', /`story:` duplicado/, 'el motivo lo dice en castellano');
  const m = M.measureRepo(repo, null, {});
  assert.ok((m.notMeasured || []).some((x) => /duplicado/.test(x)),
    `not_measured tiene que nombrarlo y trajo: ${JSON.stringify(m.notMeasured)}`);
});

test('T23 · un cambio de estado que sólo vive en un commit de MERGE no es invisible', () => {
  // 🔴 rojo: `git log --raw` sin `--diff-merges=first-parent` NO emite líneas para un commit de
  //    merge, así que la resolución de un conflicto sobre la línea `status:` desaparece: la serie
  //    queda truncada sin error, sin aviso y sin figurar en `not_measured`.
  const { repo } = nuevoRepo('merge');
  escribir(repo, 'specs/story-m.md', story('MRG-1', 'draft'));
  commit(repo, 'raíz', '2026-05-01T10:00:00-00:00');
  sh(repo, 'git', ['checkout', '-q', '-b', 'rama']);
  escribir(repo, 'specs/story-m.md', story('MRG-1', 'in-progress'));
  commit(repo, 'rama: a in-progress', '2026-05-02T10:00:00-00:00');
  sh(repo, 'git', ['checkout', '-q', '-']);
  escribir(repo, 'specs/story-m.md', story('MRG-1', 'review'));
  commit(repo, 'main: a review', '2026-05-03T10:00:00-00:00');
  try { sh(repo, 'git', ['merge', '--no-commit', 'rama']); } catch { /* conflicto esperado */ }
  escribir(repo, 'specs/story-m.md', story('MRG-1', 'done'));   // se resuelve a un valor NUEVO
  commit(repo, 'merge resuelto a done', '2026-05-04T10:00:00-00:00');

  const r = M.derivarTransiciones(repo, storiesActuales(repo), {});
  const serie = (r.transiciones['MRG-1'] || []).map((t) => t.a);
  assert.ok(serie.includes('done'),
    `el estado que sólo existe en la resolución del merge tiene que estar en la serie: ${JSON.stringify(serie)}`);
});

test('T24 · si el `story:` cambia dentro del mismo archivo, la historia previa no se pierde', () => {
  // 🔴 rojo: quedarse sólo con las versiones cuyo id declarado ya es el ACTUAL → todo lo anterior
  //    a la renumeración se descarta sin motivo, sin `sin_historial` y sin `sin_transiciones`:
  //    indistinguible de "nunca existió".
  const { repo } = nuevoRepo('renumerada');
  escribir(repo, 'specs/story-r.md', story('R-1', 'draft'));
  commit(repo, 'nace como R-1', '2026-05-01T10:00:00-00:00');
  escribir(repo, 'specs/story-r.md', story('R-1', 'in-progress'));
  commit(repo, 'R-1 a in-progress', '2026-05-03T10:00:00-00:00');
  escribir(repo, 'specs/story-r.md', story('R-2', 'review'));   // se renumera Y cambia de estado
  commit(repo, 'renumerada a R-2 y a review', '2026-05-06T10:00:00-00:00');

  const r = M.derivarTransiciones(repo, storiesActuales(repo), {});
  const serie = (r.transiciones['R-2'] || []).map((t) => `${t.de}→${t.a}`);
  assert.deepEqual(serie, ['draft→in-progress', 'in-progress→review'],
    `la historia previa a la renumeración tiene que seguir ahí y salió ${JSON.stringify(serie)}`);
  assert.deepEqual(r.idsRenumerados, ['R-2'], 'y la renumeración se deja anotada, no se esconde');
});

test('T25 · renombrar Y renumerar a la vez no borra la historia en silencio', () => {
  // 🔴 rojo: la ruta vieja no está en el mapa de rutas actuales y el id viejo ya no existe, así
  //    que la versión no matchea por ninguno de los dos lados y se descarta — sin sumar a
  //    `sin_historial` ni a `renumeradas`. Pérdida de historia MUDA.
  const { repo } = nuevoRepo('mudanza-y-renumero');
  escribir(repo, 'specs/story-v.md', story('V-1', 'draft'));
  commit(repo, 'nace como V-1 en specs/', '2026-05-01T10:00:00-00:00');
  escribir(repo, 'specs/story-v.md', story('V-1', 'in-progress'));
  commit(repo, 'V-1 a in-progress', '2026-05-03T10:00:00-00:00');
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
  sh(repo, 'git', ['mv', 'specs/story-v.md', 'docs/story-v.md']);
  commit(repo, 'se muda a docs/', '2026-05-05T10:00:00-00:00');
  escribir(repo, 'docs/story-v.md', story('V-2', 'review'));   // renumera Y cambia de estado
  commit(repo, 'renumerada a V-2 y a review', '2026-05-08T10:00:00-00:00');

  const r = M.derivarTransiciones(repo, storiesActuales(repo), {});
  const serie = (r.transiciones['V-2'] || []).map((t) => `${t.de}→${t.a}`);
  assert.deepEqual(serie, ['draft→in-progress', 'in-progress→review'],
    `la historia previa a la mudanza+renumeración tiene que seguir ahí y salió ${JSON.stringify(serie)}`);
  assert.deepEqual(r.idsRenumerados, ['V-2'], 'y la renumeración queda anotada');
  assert.equal(r.versionesHuerfanas, 0, 'ninguna versión puede quedar sin atribuir en silencio');
});

test('T26 · una versión que NO se puede atribuir se cuenta y se dice — nunca se descarta callado', () => {
  // 🔴 rojo: `if (!id) continue` a secas. Un `.md` con frontmatter de story que ya no existe en
  //    el repo (borrada, o de otro producto) tiene que quedar CONTADO, no evaporado: la diferencia
  //    entre "no hay" y "no pude atribuirlo" es la que este arnés existe para no perder.
  const { repo } = nuevoRepo('huerfanas');
  escribir(repo, 'specs/story-viva.md', story('W-1', 'draft'));
  escribir(repo, 'specs/story-muerta.md', story('Z-9', 'draft'));
  commit(repo, 'nacen las dos', '2026-05-01T10:00:00-00:00');
  escribir(repo, 'specs/story-muerta.md', story('Z-9', 'done'));
  commit(repo, 'Z-9 cierra', '2026-05-02T10:00:00-00:00');
  sh(repo, 'git', ['rm', '-q', 'specs/story-muerta.md']);
  commit(repo, 'Z-9 se borra del repo', '2026-05-03T10:00:00-00:00');
  escribir(repo, 'specs/story-viva.md', story('W-1', 'review'));
  commit(repo, 'W-1 a review', '2026-05-04T10:00:00-00:00');

  const r = M.derivarTransiciones(repo, storiesActuales(repo), {});
  assert.ok(r.transiciones['W-1'], 'la story viva se mide igual');
  assert.ok(r.versionesHuerfanas >= 2, `las versiones de la story borrada se cuentan (fueron ${r.versionesHuerfanas})`);
});

test('T27 · con el presupuesto agotado NO se sale a buscar la cadena de renombres', () => {
  // 🔴 rojo: llamar a `mapaDeRenombres` siempre. Es OTRO `git log` sobre todo el historial, con
  //    su propio tope de 2 minutos: agotado el presupuesto, seguir gastando ahí reproduce el
  //    cuelgue que el presupuesto existe para impedir — y el motivo publicado no lo diría.
  const { repo } = nuevoRepo('agotado-sin-renombres');
  escribir(repo, 'specs/story-x.md', story('X-1', 'draft'));       commit(repo, 'nace', '2026-05-01T10:00:00-00:00');
  escribir(repo, 'specs/story-x.md', story('X-1', 'in-progress')); commit(repo, 'ip', '2026-05-02T10:00:00-00:00');

  let consultada = false;
  const espia = () => { consultada = true; return new Map(); };
  const r = M.derivarTransiciones(repo, storiesActuales(repo), {
    budgetMs: 1, mapaRenombres: espia,
  });
  assert.ok(r.agotado, 'el presupuesto tiene que estar agotado en este caso');
  assert.equal(consultada, false, 'con el presupuesto agotado no se puede gastar en otro git log');

  // y sin agotarse, SÍ se consulta (si no, el caso pasaría con la función borrada)
  let consultada2 = false;
  M.derivarTransiciones(repo, storiesActuales(repo), {
    mapaRenombres: () => { consultada2 = true; return new Map(); },
  });
  assert.equal(consultada2, true, 'sin agotarse, la cadena de renombres sí se arma');
});

test('T28 · el presupuesto agotado no PISA el motivo de los ids duplicados', () => {
  // 🔴 rojo: `motivo = ...` en vez de concatenar en la rama del agotamiento → con las dos causas
  //    juntas, la del duplicado desaparece del texto Y del dato (que se anula por agotamiento):
  //    el repo queda sin ninguna señal de que además tenía ids repetidos.
  const { repo } = nuevoRepo('dos-causas');
  escribir(repo, 'specs/d-a.md', story('DD-1', 'draft'));
  escribir(repo, 'specs/d-b.md', story('DD-1', 'draft'));
  commit(repo, 'dos con el mismo id', '2026-05-01T10:00:00-00:00');
  escribir(repo, 'specs/d-a.md', story('DD-1', 'done'));
  commit(repo, 'una cierra', '2026-05-02T10:00:00-00:00');

  const r = M.derivarTransiciones(repo, storiesActuales(repo), { budgetMs: 1 });
  assert.ok(r.agotado, 'presupuesto agotado');
  assert.match(r.motivo || '', /duplicado/, 'la causa del duplicado NO puede desaparecer del motivo');
  assert.match(r.motivo || '', /presupuesto de tiempo agotado/, 'y la del presupuesto tampoco');
});

test('T29 · si la consulta de renombres FALLA, se dice — no se lee como «no hay renombres»', () => {
  // 🔴 rojo: devolver un Map vacío ante el fallo del `git log`. "No pude mirar" queda
  //    indistinguible de "miré y no hay", justo en el caso donde más importa (repo grande, la
  //    operación más lenta del archivo, con su propio tope de 2 minutos aparte del presupuesto).
  const { repo } = nuevoRepo('renombres-rotos');
  escribir(repo, 'specs/story-y.md', story('Y-1', 'draft'));       commit(repo, 'nace', '2026-05-01T10:00:00-00:00');
  escribir(repo, 'specs/story-y.md', story('Y-1', 'in-progress')); commit(repo, 'ip', '2026-05-02T10:00:00-00:00');

  const roto = M.derivarTransiciones(repo, storiesActuales(repo), {
    mapaRenombres: () => ({ mapa: new Map(), ok: false }),
  });
  assert.equal(roto.renombresLeidos, false, 'tiene que quedar constancia de que no se pudo mirar');
  assert.match(roto.motivo || '', /renombres/, 'y el motivo lo dice');
  assert.ok(roto.transiciones['Y-1'], 'la serie que sí se pudo derivar se publica igual');

  const sano = M.derivarTransiciones(repo, storiesActuales(repo), {});
  assert.equal(sano.renombresLeidos, true, 'cuando sí se pudo, no hay motivo que inventar');
  assert.equal(sano.motivo, null);
});

test('T30 · una cadena de renombres más larga que el tope deja marca', () => {
  // 🔴 rojo: cortar en el tope de saltos y seguir como si nada. Un corte sin marca es un dato
  //    incompleto que se lee como completo — la falla de siempre.
  //    El fixture necesita una ruta que NO sea de hoy (si lo fuera, la cadena ni se recorre):
  //    la de una story borrada. La cadena circular garantiza alcanzar el tope sin depender de
  //    cincuenta renombres reales.
  const { repo } = nuevoRepo('cadena-larga');
  escribir(repo, 'specs/story-z.md', story('ZZ-1', 'draft'));       commit(repo, 'nace', '2026-05-01T10:00:00-00:00');
  escribir(repo, 'specs/muerta.md', story('ZZ-9', 'draft'));        commit(repo, 'nace la que se borra', '2026-05-02T10:00:00-00:00');
  sh(repo, 'git', ['rm', '-q', 'specs/muerta.md']);                 commit(repo, 'se borra', '2026-05-03T10:00:00-00:00');
  escribir(repo, 'specs/story-z.md', story('ZZ-1', 'in-progress')); commit(repo, 'ip', '2026-05-04T10:00:00-00:00');

  const circular = new Map([['specs/muerta.md', 'otro.md'], ['otro.md', 'specs/muerta.md']]);
  const r = M.derivarTransiciones(repo, storiesActuales(repo), {
    mapaRenombres: () => ({ mapa: circular, ok: true }),
  });
  assert.ok(r.transiciones['ZZ-1'], 'la story que sí se puede atribuir no se ve afectada');
  assert.ok(r.cadenasTruncadas >= 1,
    `el corte de la cadena tiene que quedar contado y fue ${r.cadenasTruncadas}`);

  // y sin cadena circular NO se cuenta ningún corte (si no, el caso pasaría siempre)
  const limpio = M.derivarTransiciones(repo, storiesActuales(repo), {});
  assert.equal(limpio.cadenasTruncadas, 0, 'sin cadena circular no se corta nada');
});

test('T31 · el invariante se puede verificar desde el snapshot PUBLICADO, no sólo por dentro', () => {
  // 🔴 rojo: dejar `medidas` y `archivos_duplicados` adentro de la función. Quien lee el snapshot
  //    no puede reconstruir cuántas se midieron: `stories_total - sin_transiciones - sin_historial`
  //    se pasa de más EXACTAMENTE en la cantidad de archivos duplicados, sin ningún campo que lo
  //    delate. Un invariante que sólo cierra por dentro no es verificable — es una promesa.
  const { root, repo } = nuevoRepo('invariante-publicado');
  escribir(repo, 'specs/dup-a.md', story('DP-1', 'draft'));
  escribir(repo, 'specs/dup-b.md', story('DP-1', 'backlog'));
  escribir(repo, 'specs/sana.md', story('SA-1', 'draft'));
  commit(repo, 'nacen', '2026-05-01T10:00:00-00:00');
  escribir(repo, 'specs/sana.md', story('SA-1', 'done'));
  commit(repo, 'SA-1 cierra', '2026-05-04T10:00:00-00:00');

  const SCRIPT = path.resolve(__dirname, '..', 'metrics', 'sdlc-stage-metrics.js');
  const d = JSON.parse(execFileSync('node', [SCRIPT, '--repo', repo, '--json'],
    { encoding: 'utf8', env: { ...process.env, ...SIN_DESCUBRIDOR } }));
  const r = d.repos[0];
  for (const k of ['stories_medidas', 'archivos_duplicados', 'ids_duplicados', 'ids_renumerados',
    'cadenas_truncadas', 'versiones_huerfanas']) {
    assert.ok(k in r, `falta ${k} en el snapshot publicado`);
  }
  assert.deepEqual(r.ids_duplicados, ['DP-1']);
  assert.equal(r.archivos_duplicados, 2);
  assert.equal(
    r.stories_medidas + r.sin_transiciones + r.sin_historial + r.archivos_duplicados,
    r.stories_total,
    'el invariante tiene que cerrar CON LOS CAMPOS DEL ARCHIVO, sin mirar el código');
  assert.ok(root);
});

test('T32 · una cadena de renombres cortada llega al motivo, no muere adentro de la función', () => {
  // 🔴 rojo: contar el corte y no cablearlo a `motivo`/`not_measured`. La marca quedaría y moriría
  //    en la función: desde afuera, un repo con historia perdida se vería «medido» y normal.
  const { repo } = nuevoRepo('corte-visible');
  escribir(repo, 'specs/story-c.md', story('CC-1', 'draft'));   commit(repo, 'nace', '2026-05-01T10:00:00-00:00');
  escribir(repo, 'specs/muerta.md', story('CC-9', 'draft'));    commit(repo, 'nace la que se borra', '2026-05-02T10:00:00-00:00');
  sh(repo, 'git', ['rm', '-q', 'specs/muerta.md']);             commit(repo, 'se borra', '2026-05-03T10:00:00-00:00');
  escribir(repo, 'specs/story-c.md', story('CC-1', 'review'));  commit(repo, 'review', '2026-05-04T10:00:00-00:00');

  const circular = new Map([['specs/muerta.md', 'otro.md'], ['otro.md', 'specs/muerta.md']]);
  const opts = { mapaRenombres: () => ({ mapa: circular, ok: true }) };
  const r = M.derivarTransiciones(repo, storiesActuales(repo), opts);
  assert.ok(r.cadenasTruncadas >= 1);
  assert.match(r.motivo || '', /cadena/, 'el corte tiene que estar en el motivo');
  const m = M.measureRepo(repo, null, opts);
  assert.ok((m.notMeasured || []).some((x) => /cadena/.test(x)),
    `y llegar a not_measured; trajo: ${JSON.stringify(m.notMeasured)}`);
  assert.equal(m.cadenasTruncadas, r.cadenasTruncadas, 'el dato también sale de measureRepo');
});

test('T33 · si la consulta del historial FALLA de entrada, el repo sale no medido — no con ceros', () => {
  // 🔴 rojo: devolver el objeto "vacío" con `medidas: 0`, `sinTransiciones: 0` y `sin_historial: 0`
  //    cuando el `git log` ni siquiera pudo correr. Se lee como "medí limpio y no había nada", el
  //    invariante se rompe (0+0+0+null ≠ total) y el repo contamina el número GLOBAL sumando como
  //    medible. El tope de esta llamada (120 s) NO lo gobierna el presupuesto, así que este camino
  //    es distinto del agotamiento y necesitaba su propio freno.
  //    Fixture sin trampas: un repo git recién iniciado, SIN commits — ahí `git log` falla de verdad.
  const { repo } = nuevoRepo('sin-commits');
  escribir(repo, 'specs/story-s.md', story('SS-1', 'draft'));   // en disco, nunca commiteada

  const stories = storiesActuales(repo);
  assert.equal(stories.length, 1, 'la story está en disco aunque el repo no tenga commits');

  const r = M.derivarTransiciones(repo, stories, {});
  assert.equal(r.medible, false, 'tiene que declararse NO medible');
  assert.match(r.motivo || '', /no se pudo leer el historial/, 'y decir por qué, en castellano');

  const m = M.measureRepo(repo, null, {});
  for (const [campo, valor] of Object.entries({
    tiempoPorEtapa: m.tiempoPorEtapa, sinTransiciones: m.sinTransiciones,
    storiesMedidas: m.storiesMedidas, storiesSinHistorial: m.storiesSinHistorial,
    archivosDuplicados: m.archivosDuplicados,
  })) {
    assert.equal(valor, null, `${campo} tiene que ser null, no 0 (0 se lee como "medí y no hay")`);
  }
  assert.ok((m.notMeasured || []).some((x) => /no se pudo leer el historial/.test(x)),
    `not_measured tiene que nombrarlo y trajo: ${JSON.stringify(m.notMeasured)}`);
});

test('T34 · una versión con el frontmatter ilegible se cuenta — cierra la clase entera', () => {
  // 🔴 rojo: `if (!c) continue` a secas. Una versión cuyo `status:` no se puede leer se salteaba
  //    sin dejar rastro: la serie sale más corta y nada lo dice. Es el MISMO patrón que los otros
  //    siete caminos de "no pude": cada uno se cuenta y se dice, no se calla.
  const { repo } = nuevoRepo('frontmatter-roto');
  escribir(repo, 'specs/story-f.md', story('FR-1', 'draft'));
  commit(repo, 'nace bien', '2026-05-01T10:00:00-00:00');
  // el frontmatter no cierra: el lector no puede sacar el estado de esta versión
  escribir(repo, 'specs/story-f.md', '---\nstory: FR-1\nepic: 1\nstatus: in-progress\n\n# sin cerrar\n');
  commit(repo, 'queda ilegible', '2026-05-03T10:00:00-00:00');
  escribir(repo, 'specs/story-f.md', story('FR-1', 'review'));
  commit(repo, 'vuelve a estar bien', '2026-05-05T10:00:00-00:00');

  const r = M.derivarTransiciones(repo, storiesActuales(repo), {});
  assert.ok(r.versionesIlegibles >= 1,
    `la versión ilegible tiene que quedar contada y fueron ${r.versionesIlegibles}`);
  assert.match(r.motivo || '', /ileg/, 'y el motivo lo dice');
  const m = M.measureRepo(repo, null, {});
  assert.ok((m.notMeasured || []).some((x) => /ileg/.test(x)),
    `y llega a not_measured; trajo: ${JSON.stringify(m.notMeasured)}`);
  assert.equal(m.versionesIlegibles, r.versionesIlegibles, 'el dato sale de measureRepo');
});

test('T35 · el resumen global de estados desconocidos también distingue «no pude» de «no hay»', () => {
  // 🔴 rojo: dejar `estados_desconocidos: descGlobal` sin guarda. Sus tres hermanos del global
  //    (`tiempo_por_etapa`, `sin_transiciones`, `sin_historial`) sí la tienen: si NINGÚN repo se
  //    pudo medir, un `{}` se lee como «medí todo y no había nada raro». El propio archivo tiene
  //    un comentario diciendo que un objeto vacío ahí es mentira.
  const { repo } = nuevoRepo('global-sin-medir');   // repo git SIN commits: nada se puede medir
  escribir(repo, 'specs/story-g.md', story('GG-1', 'draft'));

  const SCRIPT = path.resolve(__dirname, '..', 'metrics', 'sdlc-stage-metrics.js');
  const d = JSON.parse(execFileSync('node', [SCRIPT, '--repo', repo, '--json'],
    { encoding: 'utf8', env: { ...process.env, ...SIN_DESCUBRIDOR } }));
  assert.equal(d.global.tiempo_por_etapa, null);
  assert.equal(d.global.sin_transiciones, null);
  assert.equal(d.global.sin_historial, null);
  assert.equal(d.global.estados_desconocidos, null,
    'sin ningún repo medible, el resumen de estados raros es null — un {} sería mentira');
});

test('canonEstado: canónico, alias, desconocido y vacío — llamado directo, no de rebote', () => {
  // 🔴 rojo: devolver el crudo sin marcar cuando no está en el diccionario, o tratar '' como un
  //    estado más (sería una transición fantasma desde/hacia la nada).
  assert.deepEqual(M.canonEstado('review'), { estado: 'review', desconocido: null });
  assert.deepEqual(M.canonEstado('  DONE  '), { estado: 'done', desconocido: null }, 'insensible a mayúsculas y espacios');
  assert.deepEqual(M.canonEstado('vigente'), { estado: 'done', desconocido: null }, 'alias');
  assert.deepEqual(M.canonEstado('loquesea'), { estado: 'desconocido:loquesea', desconocido: 'loquesea' });
  for (const v of ['', '   ', null, undefined]) {
    assert.equal(M.canonEstado(v), null, `"${v}" no es un estado: tiene que dar null, no una etapa`);
  }
});

test('un repo cortado por presupuesto NO aporta su parte al número global', () => {
  // 🔴 rojo: devolver `tr.transiciones` / `tr.desconocidos` sin gatear por `tr.agotado`.
  //    El presupuesto puede agotarse DESPUÉS de haber leído algún lote, y esas stories quedan con serie completa:
  //    el repo publica "no medido" en su fila y su muestra PARCIAL entra igual al número global,
  //    que sale "medido". Y no es una muestra cualquiera — `git log` entrega del commit más nuevo
  //    al más viejo, así que lo que se alcanza a leer está sesgado hacia lo reciente.
  //
  // Fixture propio y chico, con reloj falso: con el reloj real el caso dependería de la velocidad
  // de la máquina y sería intermitente. Medido: con lotes de 1 blob y 3 lotes permitidos, G-1
  // queda con serie COMPLETA y el presupuesto agotado — que es justo el escenario del defecto
  // (con 2 no alcanza a completarse ninguna, con 5 ya no se agota).
  const { repo } = nuevoRepo('agotado');
  const d = (n) => new Date(Date.now() - n * 86400000).toISOString().replace(/\.\d+Z$/, '-00:00');
  escribir(repo, 'specs/story-g.md', story('G-1', 'ready-for-dev')); commit(repo, 'g nace', d(110));
  escribir(repo, 'specs/story-g.md', story('G-1', 'in-progress'));   commit(repo, 'g ip', d(108));
  escribir(repo, 'specs/story-g.md', story('G-1', 'review'));        commit(repo, 'g review', d(104));
  escribir(repo, 'specs/story-a.md', story('A-1', 'draft'));         commit(repo, 'a nace', d(120));
  escribir(repo, 'specs/story-a.md', story('A-1', 'done'));          commit(repo, 'a done', d(96));
  const stories = storiesActuales(repo);

  const relojDe = (lotes) => { let n = 0; return () => (n++ <= lotes ? 0 : 999999); };

  const r = M.derivarTransiciones(repo, stories, { budgetMs: 10, loteBlobs: 1, reloj: relojDe(3) });
  assert.ok(r.agotado, 'el presupuesto tiene que haberse agotado');
  assert.ok(r.agotado.blobs >= 1, `y DESPUÉS de leer algún lote (leyó ${r.agotado.blobs})`);
  assert.ok(Object.keys(r.transiciones).length > 0,
    'la derivación cruda sí tiene una serie completa — por eso el gate tiene que estar en measureRepo');

  const m = M.measureRepo(repo, null, { budgetMs: 10, loteBlobs: 1, reloj: relojDe(3) });
  assert.equal(m.tiempoPorEtapa, null, 'el repo se declara no medido');
  assert.equal(m.transiciones, null, 'y NO entrega series: lo que alimenta el global viene vacío');
  assert.equal(m.estadosDesconocidos, null, 'los estados desconocidos parciales tampoco se cuelan');
  assert.equal(m.sinTransiciones, null);
  assert.equal(m.storiesSinHistorial, null);
  assert.ok((m.notMeasured || []).some((x) => /presupuesto de tiempo agotado/.test(x)),
    'y lo dice, con su motivo');
});

test('nadie se pierde en el camino: medidas + sin_transiciones + sin_historial = el total', () => {
  // 🔴 rojo: dejar las stories cuyas versiones no se pudieron leer fuera de TODA cuenta — se van
  //    del denominador en silencio, que es lo que está prohibido. La suma es el invariante que
  //    lo delata sin depender de poder reproducir un clon parcial sin red.
  const { repo } = fixturePrincipal();
  const stories = storiesActuales(repo);
  const r = M.derivarTransiciones(repo, stories, SIN_DESCUBRIDOR);
  assert.equal(r.medidas + r.sinTransiciones + r.storiesFaltantes.length, stories.length,
    'medidas + sin_transiciones + sin_historial tiene que dar el total de stories');
  const m = M.measureRepo(repo, null, SIN_DESCUBRIDOR);
  assert.equal(m.storiesSinHistorial, 0, 'en un clon completo no puede faltar ninguna versión');
});

test('la forma del snapshot es UNA sola: --json y --snapshot no pueden divergir', () => {
  // 🔴 rojo: volver a duplicar la definición del snapshot
  //    y agregar un campo en un solo lado → las claves dejan de coincidir.
  const { root, repo } = fixturePrincipal();
  const dash = path.join(root, 'dash');
  const SCRIPT = path.resolve(__dirname, '..', 'metrics', 'sdlc-stage-metrics.js');
  const env = { ...process.env, ...SIN_DESCUBRIDOR };
  const dJson = JSON.parse(execFileSync('node', [SCRIPT, '--repo', repo, '--json'], { encoding: 'utf8', env }));
  execFileSync('node', [SCRIPT, '--repo', repo, '--dashboard', dash, '--snapshot'], { encoding: 'utf8', env });
  const f = fs.readdirSync(dash).find((x) => x.startsWith('sdlc-stage-'));
  assert.ok(f, 'el --snapshot tiene que haber escrito su archivo');
  const dSnap = JSON.parse(fs.readFileSync(path.join(dash, f), 'utf8'));
  assert.deepEqual(Object.keys(dJson).sort(), Object.keys(dSnap).sort(), 'las claves de arriba difieren');
  assert.deepEqual(Object.keys(dJson.global).sort(), Object.keys(dSnap.global).sort(), 'las claves de global difieren');
  assert.deepEqual(Object.keys(dJson.repos[0]).sort(), Object.keys(dSnap.repos[0]).sort(), 'las claves por repo difieren');
});

test('el snapshot suma los tres campos nuevos sin tocar los viejos', () => {
  // 🔴 rojo: escribir tiempo_por_etapa como {} cuando no hay nada → un cero disfrazado.
  const { repo } = fixturePrincipal();
  const out = execFileSync('node', [path.resolve(__dirname, '..', 'metrics', 'sdlc-stage-metrics.js'),
    '--repo', repo, '--json'], { encoding: 'utf8', env: { ...process.env, ...SIN_DESCUBRIDOR } });
  const d = JSON.parse(out);
  const r = d.repos[0];
  for (const k of ['tiempo_por_etapa', 'sin_transiciones', 'estados_desconocidos', 'sin_historial']) {
    assert.ok(k in r, `falta ${k} en el repo del snapshot`);
    assert.ok(k in d.global, `falta ${k} en el global del snapshot`);
  }
  for (const k of ['lead_time_days', 'rework_ratio', 'dod_evidence_ratio', 'stories_total', 'done_total', 'not_measured']) {
    assert.ok(k in r, `el campo viejo ${k} no puede desaparecer del snapshot`);
  }
  assert.ok(d.global.tiempo_por_etapa['in-progress'], 'el global agrega las etapas de todos los repos');
  assert.equal(d.global.estados_desconocidos.whatever, 1);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// El contador del PRESENTE, el criterio único de «cerrado», y sus frenos.
//
// Los casos de arriba (las transiciones) no dependen de este contador. «T14 · los estados del diccionario son los
// medidos» asserta el contenido del diccionario completo.
//
// 🔴 Estos casos miden el estado ACTUAL de cada story (el `status:` vigente), que es otra cosa
//    que `estados_desconocidos`: ése mira cada versión HISTÓRICA. Dos campos casi homónimos que
//    miden cosas distintas es exactamente cómo se elige el equivocado, así que cada caso dice
//    cuál está mirando.
// ═════════════════════════════════════════════════════════════════════════════════════════════

const SCRIPT = path.resolve(__dirname, '..', 'metrics', 'sdlc-stage-metrics.js');

/** Corre el medidor como PROCESO y devuelve el snapshot. Es la forma en que lo consume el
 *  nocturno, y la única que permite verificar el invariante LEYENDO el JSON publicado (T8). */
function medirJson(repos, extraEnv = {}) {
  const args = [SCRIPT, '--json'];
  for (const r of [].concat(repos)) args.push('--repo', r);
  return JSON.parse(execFileSync('node', args,
    { encoding: 'utf8', env: { ...process.env, ...SIN_DESCUBRIDOR, ...extraEnv } }));
}

/** Escribe un diccionario de fixture y devuelve su ruta, para inyectarlo con TYCON_STATES_PATH. */
function dictFixture(dir, obj) {
  const p = path.join(dir, `estados-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
  return p;
}

/** Un diccionario mínimo pero VÁLIDO, para mutarlo caso por caso. */
const dictBase = () => ({
  canonical: ['draft', 'backlog', 'ready-for-dev', 'in-progress', 'review', 'done', 'cancelled'],
  alias: { complete: 'done', implemented: 'done', completed: 'done', closed: 'done' },
  groups: {
    backlog: ['draft', 'backlog', 'ready-for-dev'],
    en_curso: ['in-progress', 'review'],
    cerrado: ['done'],
    sin_entrega: ['cancelled'],
  },
});

// ─────────────────────────────────────────────────────────────────────────────────────────────

test('T7 · estados_por_canonico sale por repo Y global, con sus tres baldes', () => {
  // 🔴 rojo: mandar `whatever` al `estados_desconocidos` HISTÓRICO en vez de al balde
  //    nuevo → `sin_diccionario` queda vacío y el total no cierra contra stories_total.
  const { repo } = nuevoRepo('conteo-actual');
  escribir(repo, 'specs/a.md', story('CA-1', 'in-progress'));
  escribir(repo, 'specs/b.md', story('CA-2', 'in-progress'));
  escribir(repo, 'specs/c.md', story('CA-3', 'review'));
  escribir(repo, 'specs/d.md', story('CA-4', 'done'));
  escribir(repo, 'specs/e.md', story('CA-5', 'done'));
  escribir(repo, 'specs/f.md', story('CA-6', 'done'));
  escribir(repo, 'specs/g.md', story('CA-7', 'whatever'));
  // con `story:` y SIN `status:` — entra a stories_total (el medidor sólo exige el id)
  escribir(repo, 'specs/h.md', '---\nstory: CA-8\nepic: 1\n---\n\n# CA-8\n');
  commit(repo, 'ocho stories', '2026-05-01T10:00:00-00:00');

  const d = medirJson(repo);
  for (const donde of [d.repos[0], d.global]) {
    const e = donde.estados_por_canonico;
    assert.ok(e, 'estados_por_canonico tiene que estar por repo y en el global');
    assert.deepEqual(e.conteo, { 'in-progress': 2, review: 1, done: 3 },
      `el conteo del presente salió ${JSON.stringify(e.conteo)}`);
    assert.deepEqual(e.sin_diccionario, { whatever: 1 },
      'lo que el diccionario no conoce va a su balde propio, con su nombre');
    assert.equal(e.sin_status, 1, 'la story con id y sin status tiene su propio balde');
    assert.equal(e.total, 8);
  }
  assert.equal(d.repos[0].stories_total, 8, 'y el total es el mismo stories_total de siempre');
});

test('T8 · el invariante se verifica LEYENDO el JSON publicado, sin correr el código', () => {
  // 🔴 rojo: excluir cualquiera de los tres baldes (típico: descartar las stories sin
  //    `status:` para que la cuenta «cierre») → la suma no da stories_total y el caso lo dice.
  const { repo } = nuevoRepo('invariante');
  escribir(repo, 'specs/a.md', story('IV-1', 'done'));
  escribir(repo, 'specs/b.md', story('IV-2', 'review'));
  escribir(repo, 'specs/c.md', story('IV-3', 'chirimbolo'));
  escribir(repo, 'specs/d.md', '---\nstory: IV-4\nepic: 1\n---\n\n# IV-4\n');
  commit(repo, 'cuatro', '2026-05-01T10:00:00-00:00');

  const d = medirJson(repo);
  const suma = (o) => Object.values(o).reduce((a, b) => a + b, 0);
  for (const donde of [d.repos[0], d.global]) {
    const e = donde.estados_por_canonico;
    const total = suma(e.conteo) + suma(e.sin_diccionario) + e.sin_status;
    assert.equal(total, e.total, 'conteo + sin_diccionario + sin_status tiene que dar el total');
    // `por_grupo` puede sumar MENOS que el conteo sólo si hay un canónico sin grupo — y eso lo
    // prohíbe T6. Acá el diccionario es el real, así que tienen que coincidir.
    assert.equal(suma(e.por_grupo), suma(e.conteo),
      'sum(por_grupo) tiene que dar lo mismo que sum(conteo): si no, hay un canónico sin grupo');
  }
  assert.equal(d.repos[0].estados_por_canonico.total, d.repos[0].stories_total,
    'y el total del contador ES stories_total, no un universo propio');
});

test('T16 · un estado inventado no se descarta NUNCA', () => {
  // 🔴 rojo: `if (!DICT[s]) continue` → la story se evapora del denominador y `chirimbolo`
  //    no aparece en ningún lado. Es un invariante del medidor; se re-verifica acá porque este
  //    caso toca justo esa función.
  const { repo } = nuevoRepo('inventado');
  escribir(repo, 'specs/a.md', story('IN-1', 'done'));
  escribir(repo, 'specs/b.md', story('IN-2', 'chirimbolo'));
  commit(repo, 'nacen', '2026-05-01T10:00:00-00:00');
  escribir(repo, 'specs/b.md', story('IN-2', 'chirimbolo', 'toque'));
  commit(repo, 'se toca sin cambiar de estado', '2026-05-03T10:00:00-00:00');

  const d = medirJson(repo);
  const r = d.repos[0];
  assert.equal(r.stories_total, 2, 'la story rara SIGUE en el denominador');
  assert.equal(r.estados_por_canonico.sin_diccionario.chirimbolo, 1,
    'y aparece con su nombre en el contador del presente');
  assert.equal(r.estados_desconocidos.chirimbolo, 1,
    'y también en el contador HISTÓRICO, que mide otra cosa y no se toca');
  assert.equal(M.canonEstado('chirimbolo').estado, 'desconocido:chirimbolo');
});

test('T9 · «no pude medir» son DOS cosas — y un historial ilegible NO es una de ellas', () => {
  // 🔴 rojo: gatear el contador del presente por el presupuesto de transiciones (copiar el
  //    patrón de su campo hermano `estados_desconocidos`) → el caso (b) sale `null` TENIENDO el
  //    dato. Es el «no medido» falso, y ya pasó: el presupuesto de 60 s se agota en repos reales.
  //    El estado ACTUAL se lee del frontmatter y ahí está disponible siempre.

  // (a) no es un repo git → null con motivo
  const noGit = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-nogit-'));
  fs.mkdirSync(path.join(noGit, 'specs'), { recursive: true });
  fs.writeFileSync(path.join(noGit, 'specs', 'a.md'), story('NG-1', 'done'));
  const ma = M.measureRepo(noGit, null, {});
  assert.ok(ma.error, 'un directorio que no es repo git sale con error');
  const da = medirJson(noGit);
  assert.equal(da.repos[0].estados_por_canonico, null,
    'y su estados_por_canonico es null, jamás {} ni un objeto de ceros');

  // (b) historial ilegible (repo sin commits: `git log` falla de verdad) pero frontmatter sano
  const { repo } = nuevoRepo('sin-commits-contador');
  escribir(repo, 'specs/a.md', story('SC-1', 'in-progress'));
  escribir(repo, 'specs/b.md', story('SC-2', 'done'));
  const mb = M.measureRepo(repo, null, {});
  assert.equal(mb.tiempoPorEtapa, null, 'el tiempo por etapa SÍ sale no medido (depende de git)');
  assert.ok(mb.estadosPorCanonico, 'pero el contador del presente NO: el dato está en el disco');
  assert.deepEqual(mb.estadosPorCanonico.conteo, { 'in-progress': 1, done: 1 });
  assert.equal(mb.estadosPorCanonico.total, 2);
});

test('T4 · cancelar no es entregar', () => {
  // 🔴 rojo: mapear `cancelled → done` (es lo cómodo: «ya no están abiertas») → done_total
  //    da 5 en vez de 3, y las dos ratios que se calculan SOBRE stories cerradas se mueven.
  //    🔴 NO se asserta `first_pass_ratio`: se lee de .dashboard/metrics-*.json y no mira un solo
  //    `status:`, así que ninguna mutación del diccionario podría ponerlo rojo — sería un assert
  //    vacuo que simula cobertura.
  const armar = (nombre, conCanceladas) => {
    const { repo } = nuevoRepo(nombre);
    escribir(repo, 'specs/a.md', story('CN-1', 'done'));
    escribir(repo, 'specs/b.md', story('CN-2', 'done'));
    escribir(repo, 'specs/c.md', story('CN-3', 'done'));
    if (conCanceladas) {
      escribir(repo, 'specs/d.md', story('CN-4', 'cancelled'));
      escribir(repo, 'specs/e.md', story('CN-5', 'cancelled'));
    }
    commit(repo, 'nacen', '2026-05-01T10:00:00-00:00');
    return repo;
  };
  const conCanc = medirJson(armar('cancel-con', true)).repos[0];
  const sinCanc = medirJson(armar('cancel-sin', false)).repos[0];

  assert.equal(conCanc.done_total, 3, 'las canceladas NO entran a done_total');
  assert.equal(conCanc.estados_por_canonico.conteo.cancelled, 2,
    'se cuentan aparte, con su canónico propio');
  assert.equal(conCanc.estados_por_canonico.por_grupo.cerrado, 3,
    'y el grupo «cerrado» tampoco las absorbe');
  assert.deepEqual(conCanc.rework_ratio, sinCanc.rework_ratio,
    'rework se calcula sobre cerradas: no puede moverse por dos canceladas');
  assert.deepEqual(conCanc.dod_evidence_ratio, sinCanc.dod_evidence_ratio,
    'dod_evidence tampoco');
});

test('T13 · el delta de done_total es EXACTAMENTE el esperado (ni uno más, ni uno menos)', () => {
  // 🔴 rojo: dejar `DONE_STATUSES` en el código → el delta es 0 y el caso lo dice. Sumar
  //    también las `in-progress` → da 10 y también es rojo.
  //
  // Los dos criterios se contrastan inyectando DOS diccionarios sobre el MISMO fixture: uno que
  // reproduce el criterio de una lista fija (`done`, `completed`, `closed` — ni `complete` ni
  // `implemented`) y el canónico de esta story. Comparar contra un código viejo sería imposible
  // una vez borrado; comparar dos diccionarios mide exactamente lo mismo y queda reproducible.
  const { root, repo } = nuevoRepo('delta-done');
  for (let i = 1; i <= 4; i++) escribir(repo, `specs/d${i}.md`, story(`DL-${i}`, 'done'));
  for (let i = 5; i <= 7; i++) escribir(repo, `specs/c${i}.md`, story(`DL-${i}`, 'complete'));
  escribir(repo, 'specs/i8.md', story('DL-8', 'implemented'));
  escribir(repo, 'specs/p9.md', story('DL-9', 'in-progress'));
  escribir(repo, 'specs/p10.md', story('DL-10', 'in-progress'));
  commit(repo, 'diez stories', '2026-05-01T10:00:00-00:00');

  const viejo = dictBase();
  delete viejo.alias.complete;
  delete viejo.alias.implemented;
  const antes = medirJson(repo, { TYCON_STATES_PATH: dictFixture(root, viejo) }).repos[0];
  const despues = medirJson(repo, { TYCON_STATES_PATH: dictFixture(root, dictBase()) }).repos[0];

  assert.equal(antes.done_total, 4, 'el criterio viejo sólo reconocía las 4 `done`');
  assert.equal(despues.done_total, 8,
    'el criterio nuevo suma las 3 `complete` y la `implemented` — 8, ni 7 ni 9');
  assert.equal(despues.done_total - antes.done_total, 4, 'el delta es exactamente 4');
  assert.equal(despues.estados_por_canonico.conteo['in-progress'], 2,
    'y las in-progress NO se cuelan: si dieran 10, el criterio se pasó de largo');

  // Los seis campos del invariante del recuento salen idénticos: el criterio de «cerrado» no toca
  // el recuento de quién se pudo medir.
  for (const k of ['stories_total', 'stories_medidas', 'sin_transiciones', 'sin_historial',
    'archivos_duplicados', 'ids_duplicados']) {
    assert.deepEqual(despues[k], antes[k], `el campo del invariante ${k} no puede moverse`);
  }
});

test('T18 · mover un estado de grupo mueve el conteo, sin tocar el código', () => {
  // 🔴 rojo: cachear el grupo al CARGAR el módulo en vez de leerlo AL MEDIR → el fixture
  //    no tiene ningún efecto y el caso pasa por casualidad con el diccionario del repo.
  const { root, repo } = nuevoRepo('mover-grupo');
  for (let i = 1; i <= 3; i++) escribir(repo, `specs/d${i}.md`, story(`MG-${i}`, 'done'));
  for (let i = 4; i <= 5; i++) escribir(repo, `specs/c${i}.md`, story(`MG-${i}`, 'complete'));
  commit(repo, 'cinco', '2026-05-01T10:00:00-00:00');

  // `complete` como CANÓNICO propio, dentro del grupo «cerrado»
  const conComplete = dictBase();
  delete conComplete.alias.complete;
  conComplete.canonical.push('complete');
  conComplete.groups.cerrado = ['done', 'complete'];

  // el mismo diccionario, con `complete` fuera del grupo (queda en el suyo)
  const sinComplete = JSON.parse(JSON.stringify(conComplete));
  sinComplete.groups.cerrado = ['done'];
  sinComplete.groups.en_curso = ['in-progress', 'review', 'complete'];

  const a = medirJson(repo, { TYCON_STATES_PATH: dictFixture(root, conComplete) }).repos[0];
  const b = medirJson(repo, { TYCON_STATES_PATH: dictFixture(root, sinComplete) }).repos[0];
  assert.equal(a.done_total, 5, 'con `complete` en el grupo cerrado, son 5');
  assert.equal(b.done_total, 3, 'sacándolo del grupo, bajan a 3 — sin tocar una línea de código');
  assert.equal(b.estados_por_canonico.por_grupo.en_curso, 2, 'y aparecen del otro lado');
});

test('T19 · un diccionario que no valida NO publica cero — los cinco caminos', () => {
  // 🔴 rojo: dejar que `groups.cerrado` vacío filtre a cero → `done_total: 0` y
  //    `rework: sin stories done`, todo verde, en los 20 repos. Es el caso que esta
  //    guarda existe para evitar: si la lista viviera en el código no podría pasar.
  const { root, repo } = nuevoRepo('dict-roto');
  escribir(repo, 'specs/a.md', story('DR-1', 'done'));
  escribir(repo, 'specs/b.md', story('DR-2', 'review'));
  commit(repo, 'dos', '2026-05-01T10:00:00-00:00');

  const sinGrupos = dictBase(); delete sinGrupos.groups;      // (c) — es el estado de HOY del archivo
  const vacio = dictBase(); vacio.groups.cerrado = [];        // (d)
  const noCanonico = dictBase(); noCanonico.groups.cerrado = ['complete'];  // (e) — un alias

  const caminos = [
    ['(a) archivo ausente', path.join(root, 'no-existe-este-diccionario.json')],
    ['(b) JSON roto', dictFixture(root, '{ esto no es json')],
    ['(c) sin la clave groups', dictFixture(root, sinGrupos)],
    ['(d) groups.cerrado vacío', dictFixture(root, vacio)],
    ['(e) groups.cerrado con un alias en vez del canónico', dictFixture(root, noCanonico)],
  ];

  for (const [nombre, ruta] of caminos) {
    const r = medirJson(repo, { TYCON_STATES_PATH: ruta }).repos[0];
    assert.equal(r.done_total, null, `${nombre}: done_total tiene que ser null, jamás 0`);
    assert.equal(r.estados_por_canonico, null, `${nombre}: estados_por_canonico null, jamás ceros`);
    assert.ok((r.not_measured || []).some((x) => /diccionario/i.test(x)),
      `${nombre}: el motivo tiene que nombrar al diccionario y trajo ${JSON.stringify(r.not_measured)}`);
    for (const k of ['rework_ratio', 'dod_evidence_ratio', 'lead_time_days']) {
      assert.equal(r[k], null,
        `${nombre}: ${k} se calcula sobre stories cerradas — sin saber cuáles son, es null`);
    }
  }
});

test('T6b · el AC 6 se valida EN RUNTIME, no sólo sobre el archivo commiteado', () => {
  // 🔴 `validarDiccionario()` tiene que mirar más que `groups.cerrado`. T6 valida las dos direcciones de las reglas del diccionario
  //    sobre el `states.json` COMMITEADO — pero el que llega al medidor puede ser otro (`TYCON_STATES_PATH`, un merge
  //    que pise el archivo, una edición a mano), y sin esta guarda no hay ninguna validación ahí.
  //
  // 🔴 rojo (a): un grupo con un ALIAS en vez del canónico → el diccionario pasa la
  //    validación, `review` desaparece de `por_grupo` y `sum(por_grupo) < sum(conteo)` sin que
  //    nada lo diga. (b): un canónico en DOS grupos → `porGrupo` corta en el primero que matchea,
  //    así que `por_grupo.cerrado` da 0 mientras `done_total` da 2 — dos números que el smoke del
  //    de la etapa asume iguales, desincronizados en silencio en cada corrida nocturna.
  const { root, repo } = nuevoRepo('ac6-runtime');
  escribir(repo, 'specs/a.md', story('AC6-1', 'done'));
  escribir(repo, 'specs/b.md', story('AC6-2', 'review'));
  commit(repo, 'dos', '2026-05-01T10:00:00-00:00');

  const conAlias = dictBase();
  conAlias.groups.en_curso = ['in-progress', 'complete'];   // `complete` es alias, no canónico
  const dosGrupos = dictBase();
  dosGrupos.groups.en_curso = ['in-progress', 'review', 'done'];  // `done` también en `cerrado`
  const huerfano = dictBase();
  huerfano.canonical.push('sin-grupo');                     // no figura en ningún grupo

  for (const [nombre, dic] of [['un alias en un grupo', conAlias],
    ['un canónico en dos grupos', dosGrupos], ['un canónico sin grupo', huerfano]]) {
    const r = medirJson(repo, { TYCON_STATES_PATH: dictFixture(root, dic) }).repos[0];
    assert.equal(r.estados_por_canonico, null,
      `${nombre}: el diccionario no vale, así que el contador sale null — no un conteo incompleto`);
    assert.equal(r.done_total, null, `${nombre}: y done_total tampoco publica un número`);
    assert.ok((r.not_measured || []).some((x) => /diccionario/i.test(x)),
      `${nombre}: con su motivo, y trajo ${JSON.stringify(r.not_measured)}`);
  }
});

test('T7b · un estado que se llama como una propiedad del prototipo se cuenta igual', () => {
  // 🔴 Si `conteo` y `sin_diccionario` fueran objetos literales indexados con el valor CRUDO del frontmatter, una
  //    story con `status: __proto__` (o `constructor`, o `toString`) leería la propiedad heredada en vez de un
  //    contador, y el conteo saldría mal o reventaría — con la suma sin cerrar y sin que nada dijera por qué.
  // 🔴 rojo: volver a `const conteo = {}` → `sin_diccionario.__proto__` no cuenta 1 y la
  //    suma no cierra contra stories_total.
  const { repo } = nuevoRepo('prototipo');
  escribir(repo, 'specs/a.md', story('PR-1', 'done'));
  escribir(repo, 'specs/b.md', story('PR-2', '__proto__'));
  escribir(repo, 'specs/c.md', story('PR-3', 'constructor'));
  escribir(repo, 'specs/d.md', story('PR-4', 'toString'));
  commit(repo, 'cuatro', '2026-05-01T10:00:00-00:00');

  const r = medirJson(repo).repos[0];
  const e = r.estados_por_canonico;
  const suma = (o) => Object.values(o).reduce((a, b) => a + b, 0);
  assert.equal(suma(e.conteo) + suma(e.sin_diccionario) + e.sin_status, e.total,
    `el invariante tiene que cerrar igual y trajo ${JSON.stringify(e)}`);
  assert.equal(e.total, 4);
  // Las claves salen NORMALIZADAS (`canonEstado` baja a minúscula), así que `toString` se guarda
  // como `tostring`: se asserta la forma normalizada, que es la que de verdad se publica.
  for (const raro of ['__proto__', 'constructor', 'tostring']) {
    assert.equal(e.sin_diccionario[raro], 1, `${raro} tiene que contar 1, como cualquier otro `
      + `y trajo ${JSON.stringify(e.sin_diccionario)}`);
  }
});

test('T22 · el snapshot registra QUÉ diccionario usó (ruta y hash)', () => {
  // 🔴 rojo: no registrarlo → una máquina (o un nocturno) con TYCON_STATES_PATH puesta
  //    publica métricas de OTRO diccionario y el snapshot se ve idéntico al normal. Es el caso
  //    que impide que la inyección de fixture se vuelva un interruptor invisible.
  const { root, repo } = nuevoRepo('quien-diccionario');
  escribir(repo, 'specs/a.md', story('QD-1', 'done'));
  commit(repo, 'una', '2026-05-01T10:00:00-00:00');

  const ruta = dictFixture(root, dictBase());
  const hashEsperado = require('crypto')
    .createHash('sha256').update(fs.readFileSync(ruta)).digest('hex').slice(0, 12);

  const conVar = medirJson(repo, { TYCON_STATES_PATH: ruta });
  assert.ok(conVar.global.diccionario, 'el snapshot tiene que decir qué diccionario usó');
  assert.equal(conVar.global.diccionario.ruta, ruta, 'con la ruta REAL, no la canónica');
  assert.equal(conVar.global.diccionario.hash, hashEsperado, 'y el hash del archivo que leyó');

  const sinVar = medirJson(repo);
  assert.equal(sinVar.global.diccionario.ruta, ESTADOS_PATH,
    'sin la variable, la ruta canónica del repo');
  assert.notEqual(sinVar.global.diccionario.hash, hashEsperado,
    'y su propio hash: dos diccionarios distintos no pueden verse iguales en el snapshot');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// La causa del reproceso — `rework_por_causa` por repo y global
// ═════════════════════════════════════════════════════════════════════════════════════════════

const CAUSAS_PATH = path.resolve(__dirname, '..', 'metrics', 'rework-causes.json');

/** Story que declara `followup_of:` en BLOQUE (un item por padre, con o sin `type:`) y causa opcional. */
function storyConSeguimiento(id, status, { types = ['fix'], reason = null } = {}) {
  const items = types.map((t, i) => `  - id: "P-${i + 1}"\n${t ? `    type: "${t}"\n` : ''}    summary: "sigue a P-${i + 1}"`).join('\n');
  return `---\nstory: ${id}\nepic: 1\nstatus: ${status}\nfollowup_of:\n${items}\n${reason ? `followup_reason: ${reason}\n` : ''}---\n\n# Story ${id}\n`;
}

/** El universo del caso: 7 con seguimiento (2 defecto-propio · 1 cambio-de-requisito · 3 sin causa · 1 fuera) + 2 sin. */
function fixtureCausas(nombre) {
  const { root, repo } = nuevoRepo(nombre);
  escribir(repo, 'specs/a.md', storyConSeguimiento('RC-1', 'done', { types: ['fix'], reason: 'defecto-propio' }));
  escribir(repo, 'specs/b.md', storyConSeguimiento('RC-2', 'review', { types: ['fix'], reason: 'defecto-propio' }));
  escribir(repo, 'specs/c.md', storyConSeguimiento('RC-3', 'done', { types: ['extension'], reason: 'cambio-de-requisito' }));
  escribir(repo, 'specs/d.md', storyConSeguimiento('RC-4', 'done', { types: ['extension'] }));
  escribir(repo, 'specs/e.md', storyConSeguimiento('RC-5', 'backlog', { types: ['extension'] }));
  escribir(repo, 'specs/f.md', storyConSeguimiento('RC-6', 'done', { types: ['fix'] }));
  escribir(repo, 'specs/g.md', storyConSeguimiento('RC-7', 'done', { types: ['gap-fill'], reason: 'otra-cosa' }));
  escribir(repo, 'specs/h.md', story('RC-8', 'done'));
  escribir(repo, 'specs/i.md', story('RC-9', 'in-progress'));
  commit(repo, 'nueve stories', '2026-05-01T10:00:00-00:00');
  return { root, repo };
}
const sumaCausas = (o) => Object.values(o || {}).reduce((a, b) => a + b, 0);

test('T7 (2.3) · rework_por_causa sale por repo Y global, con las cuatro causas SIEMPRE presentes', () => {
  // 🔴 rojo: omitir las causas en cero → faltan barras; mandar `otra-cosa` a `sin_declarar` →
  //    `fuera_de_vocabulario` queda vacío y el invariante cierra igual (por eso T8 asserta el mapa).
  //    Y otro: leer el bloque con `^followup_of:\s*(.*)$` —
  //    el `\s*` se come el salto de línea y la primera línea del bloque se lee como inline → 0 type
  //    → `sin_declarar_por_type` da `{sin_type: 3}` en vez del desglose real.
  const { repo } = fixtureCausas('causas-ac5');
  const d = medirJson(repo);
  for (const donde of [d.repos[0], d.global]) {
    const x = donde.rework_por_causa;
    assert.ok(x, 'rework_por_causa tiene que estar por repo y en el global');
    assert.deepEqual(x.conteo, { 'defecto-propio': 2, 'cambio-de-requisito': 1, 'deuda-declarada': 0, descubrimiento: 0 },
      `el conteo por causa salió ${JSON.stringify(x.conteo)}`);
    for (const c of ['deuda-declarada', 'descubrimiento']) {
      assert.ok(Object.prototype.hasOwnProperty.call(x.conteo, c),
        `la causa ${c} está aunque valga 0: una barra ausente y una en cero no son lo mismo`);
    }
    assert.equal(x.sin_declarar, 3, 'las tres sin followup_reason van a sin_declarar');
    assert.deepEqual(x.fuera_de_vocabulario, { 'otra-cosa': 1 },
      'un valor fuera del vocabulario se publica con su nombre, no se descarta ni se cuenta como sin declarar');
    assert.deepEqual(x.sin_declarar_por_type, { extension: 2, fix: 1, sin_type: 0 },
      `el desglose por type de las sin declarar salió ${JSON.stringify(x.sin_declarar_por_type)}`);
    assert.equal(x.total, 7, 'total = stories con followup_of no vacío, en cualquier estado');
  }
  assert.equal(d.repos[0].stories_total, 9, 'y stories_total sigue contando a todas, con y sin seguimiento');
});

test('T7b (2.3) · un seguimiento sin `type:` cuenta en sin_type; un `followup_of: []` vacío no es un seguimiento', () => {
  // 🔴 rojo: tratar `followup_of: []` como seguimiento (basta que la clave exista) → total 3
  //    en vez de 2.
  const { repo } = nuevoRepo('causas-sin-type');
  escribir(repo, 'specs/a.md', storyConSeguimiento('ST-1', 'done', { types: [null] }));      // bloque sin type
  escribir(repo, 'specs/b.md', storyConSeguimiento('ST-2', 'done', { types: ['fix'], reason: 'descubrimiento' }));
  escribir(repo, 'specs/c.md', '---\nstory: ST-3\nepic: 1\nstatus: done\nfollowup_of: []\n---\n\n# ST-3\n');
  commit(repo, 'tres', '2026-05-01T10:00:00-00:00');
  const x = medirJson(repo).repos[0].rework_por_causa;
  assert.equal(x.total, 2, '`followup_of: []` no cuenta como seguimiento');
  assert.equal(x.sin_declarar, 1);
  assert.deepEqual(x.sin_declarar_por_type, { sin_type: 1 });
  assert.equal(x.conteo.descubrimiento, 1);
});

test('T8 (2.3) · el invariante se lee del JSON publicado, sin correr el código', () => {
  // 🔴 rojo: excluir un balde → la suma no cierra contra total; tragarse el fuera de
  //    vocabulario → la suma cerraría igual mandándolo a sin_declarar, por eso se asserta el mapa.
  const { repo } = fixtureCausas('causas-invariante');
  const d = medirJson(repo);
  for (const donde of [d.repos[0], d.global]) {
    const x = donde.rework_por_causa;
    assert.equal(sumaCausas(x.conteo) + x.sin_declarar + sumaCausas(x.fuera_de_vocabulario), x.total,
      `sum(conteo) + sin_declarar + sum(fuera) tiene que dar total: ${JSON.stringify(x)}`);
    assert.equal(sumaCausas(x.sin_declarar_por_type), x.sin_declarar,
      'el desglose por type suma exactamente las sin declarar');
    assert.equal(x.fuera_de_vocabulario['otra-cosa'], 1, 'y el fuera de vocabulario está, con su nombre');
  }
});

test('T9 (2.3) · repo no medido → null con motivo; repo sin seguimientos → total 0 con las cuatro en cero', () => {
  // 🔴 rojo: publicar `{}` en (a) → se lee como «sin reproceso»; publicar `null` en (b) → un
  //    «no medido» falso teniendo el dato; gatear por el presupuesto de git en (c) → idem.
  // (a) no es un repo git
  const noGit = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-nogit-causas-'));
  fs.mkdirSync(path.join(noGit, 'specs'), { recursive: true });
  fs.writeFileSync(path.join(noGit, 'specs', 'a.md'), storyConSeguimiento('NG-1', 'done'));
  const da = medirJson(noGit);
  assert.strictEqual(da.repos[0].rework_por_causa, null, 'no medido es null, jamás {} ni un objeto de ceros');
  // El motivo de un repo que no es git viaja en `error` (contrato previo de measureRepo), no en
  // `not_measured` — que es para lo que NO se pudo medir DENTRO de un repo que sí se midió.
  assert.match(String(da.repos[0].error || ''), /no es un repo git/, 'y el motivo está escrito');

  // (b) repo sano sin ningún followup_of → «miré y no hay»
  const { repo } = nuevoRepo('sin-seguimientos');
  escribir(repo, 'specs/a.md', story('SS-1', 'done'));
  escribir(repo, 'specs/b.md', story('SS-2', 'review'));
  commit(repo, 'dos', '2026-05-01T10:00:00-00:00');
  const xb = medirJson(repo).repos[0].rework_por_causa;
  assert.ok(xb, 'un repo sin seguimientos SÍ se midió');
  assert.equal(xb.total, 0);
  assert.deepEqual(xb.conteo, { 'defecto-propio': 0, 'cambio-de-requisito': 0, 'deuda-declarada': 0, descubrimiento: 0 });
  assert.equal(xb.sin_declarar, 0);
  assert.deepEqual(xb.fuera_de_vocabulario, {});

  // (c) historial ilegible (repo sin commits) pero frontmatter sano → el dato está en el disco
  const { repo: sinCommits } = nuevoRepo('sin-commits-causas');
  escribir(sinCommits, 'specs/a.md', storyConSeguimiento('SC-1', 'done', { reason: 'deuda-declarada' }));
  const mc = M.measureRepo(sinCommits, null, {});
  assert.equal(mc.tiempoPorEtapa, null, 'el tiempo por etapa SÍ sale no medido (depende de git)');
  assert.ok(mc.reworkPorCausa, 'pero la causa del reproceso NO: se lee del frontmatter');
  assert.equal(mc.reworkPorCausa.conteo['deuda-declarada'], 1);
});

test('T9d (2.3) · un vocabulario de causas ilegible NO publica ceros, y el snapshot dice qué archivo usó', () => {
  // 🔴 rojo: con el JSON de causas roto, contar igual con una lista vacía → cuatro barras en
  //    cero y todo en sin_declarar, en verde. Y sin el rastro, TYCON_CAUSES_PATH sería un
  //    interruptor invisible — la misma guarda que lleva TYCON_STATES_PATH.
  const { root, repo } = fixtureCausas('causas-rotas');
  const roto = path.join(root, 'causas-rotas.json');
  fs.writeFileSync(roto, '{ esto no es json');
  const d = medirJson(repo, { TYCON_CAUSES_PATH: roto });
  assert.strictEqual(d.repos[0].rework_por_causa, null, 'vocabulario ilegible → null, no ceros');
  assert.strictEqual(d.global.rework_por_causa, null);
  assert.ok((d.repos[0].not_measured || []).some((m) => /causa/i.test(m)),
    'con el motivo nombrando al vocabulario');
  assert.ok(d.global.causas_reproceso, 'el snapshot registra qué vocabulario intentó usar');
  assert.equal(d.global.causas_reproceso.ruta, roto);

  const sano = medirJson(repo);
  assert.equal(sano.global.causas_reproceso.ruta, CAUSAS_PATH, 'sin la variable, el canónico del repo');
  assert.match(String(sano.global.causas_reproceso.hash || ''), /^[0-9a-f]{8,}$/, 'y su hash');
});

test('T7c (2.3) · el pase adversarial: lista sin indentar, lista vacía con comentario, y el literal en otro campo', () => {
  // Tres defectos de borde del parser de seguimientos.
  // 🔴 rojo de A: acotar el bloque con `after.search(/^\S/m)` encuentra el PROPIO guion del
  //    primer item y corta el bloque a '' → la story se evapora de total/sin_declarar SIN error.
  //    El parser hermano de `followed_up_by:` sí lo lee.
  // 🔴 rojo de B: `inline !== '[]'` → un comentario al final rompe la igualdad y una story
  //    sin seguimientos infla los contadores.
  // 🔴 rojo de E: ubicar el bloque con `fm.indexOf(fo[0])` en vez de `match.index`.
  const flushLeft = '---\nstory: FL-1\nepic: 1\nstatus: done\nfollowup_of:\n- id: "P-1"\n  type: "fix"\n  summary: "sin indentar"\n---\n\n# FL-1\n';
  const fmA = M.parseFrontmatter(flushLeft);
  assert.equal(fmA.followupOf, true, 'una lista YAML sin indentar SIGUE siendo un seguimiento');
  assert.deepEqual(fmA.followupTypes, ['fix'], 'y sus `type` se leen igual');

  const vacioComentado = '---\nstory: VC-1\nepic: 1\nstatus: done\nfollowup_of: []  # ninguno todavía\n---\n\n# VC-1\n';
  assert.equal(M.parseFrontmatter(vacioComentado).followupOf, false,
    '`followup_of: []` con un comentario al final sigue siendo una lista VACÍA');

  const literalAntes = '---\nstory: LA-1\nepic: 1\nstatus: done\ntitle: "Documentar followup_of: y su back-link"\nfollowup_of:\n  - id: "P-1"\n    type: "gap-fill"\n---\n\n# LA-1\n';
  const fmC = M.parseFrontmatter(literalAntes);
  assert.equal(fmC.followupOf, true, 'el literal en `title:` no puede tapar el bloque real');
  assert.deepEqual(fmC.followupTypes, ['gap-fill']);

  // Y el hermano `followed_up_by:` sigue leyéndose igual que siempre (no se tocó).
  assert.equal(M.parseFrontmatter('---\nstory: FU-1\nepic: 1\nstatus: done\nfollowed_up_by:\n- id: "H-1"\n---\n\n#x\n').followups,
    true, 'el parser de followed_up_by no se rompió');
});

test('T9e (2.3) · un diccionario de ESTADOS roto no apaga la causa del reproceso', () => {
  // 🔴 rojo: el retorno temprano de `measureRepo` por
  //    `dic.motivo` pone `reworkPorCausa: null` aunque el vocabulario de CAUSAS esté sano y
  //    el dato viva en el frontmatter. Es el «no medido falso» que este archivo dice evitar:
  //    contarCausas() no depende del diccionario de estados para nada.
  const { root, repo } = fixtureCausas('estados-rotos-causas-sanas');
  const dicRoto = path.join(root, 'estados-roto.json');
  fs.writeFileSync(dicRoto, '{ no soy json');
  const d = medirJson(repo, { TYCON_STATES_PATH: dicRoto });

  assert.strictEqual(d.repos[0].done_total, null, 'lo que SÍ depende del diccionario de estados sale null');
  assert.ok(d.repos[0].rework_por_causa, 'pero la causa del reproceso se mide igual: su dato está en el frontmatter');
  assert.equal(d.repos[0].rework_por_causa.total, 7);
  assert.equal(d.repos[0].rework_por_causa.conteo['defecto-propio'], 2);
  assert.ok(d.global.rework_por_causa, 'y el global también');
});

test('T9f (2.3) · un vocabulario con `causes` como ARRAY no vale como vocabulario', () => {
  // 🔴 rojo: `typeof j.causes === 'object'` es true para un array, así que
  //    `Object.keys()` devolvería los ÍNDICES ("0","1") como vocabulario — y las cuatro barras
  //    saldrían vacías, en verde.
  const { root, repo } = fixtureCausas('causas-array');
  const arr = path.join(root, 'causas-array.json');
  fs.writeFileSync(arr, JSON.stringify({ causes: ['defecto-propio', 'cambio-de-requisito'] }));
  const d = medirJson(repo, { TYCON_CAUSES_PATH: arr });
  assert.strictEqual(d.repos[0].rework_por_causa, null, 'un array no es el vocabulario: null con motivo');
  assert.ok((d.repos[0].not_measured || []).some((m) => /causa/i.test(m)));
});

test('T9g (2.3) · un descubridor canónico ROTO cae al de respaldo y SIGUE midiendo la causa', () => {
  // La rama *el descubridor de stories falló* de measureRepo
  // **no es alcanzable rompiendo el descubridor canónico**: `discoverStoryFiles` atrapa el
  // error y cae al escaneo plano por identidad declarada — fail-open RUIDOSO, que es el diseño.
  // Para llegar al `error:` habría que romper también el respaldo (un repo ilegible), y ESE camino
  // ya está cubierto por T9a («no es un repo git»).
  //
  // 🔴 Entonces el caso afirma lo que de verdad importa: que la degradación **no pierde el dato**.
  //    rojo: si alguien "arregla" el fail-open haciendo que el catch devuelva lista vacía
  //    en vez de escanear, este repo pasaría a publicar `total: 0` —«medí y no hay seguimientos»—
  //    con siete stories que sí los tienen. Eso es el cero falso, y acá se pone rojo.
  const { repo } = fixtureCausas('descubridor-roto');
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-roto-'));
  const libDir = path.join(fake, 'tycon-pipeline', 'scripts', 'lib');
  fs.mkdirSync(libDir, { recursive: true });
  fs.writeFileSync(path.join(libDir, 'story-discovery.js'),
    'module.exports = { findRepoRoot(){return null}, discoverStories(){ throw new Error("descubridor roto a propósito") } };\n');

  const d = medirJson(repo, { TYCON_SKILLS_DIR: fake });
  const x = d.repos[0].rework_por_causa;
  assert.ok(x, 'con el descubridor roto se mide igual, por el escaneo de respaldo');
  assert.equal(x.total, 7, 'y NO publica un 0: las siete stories con seguimiento siguen contadas');
  assert.equal(d.repos[0].canonical_discovery, false,
    'el snapshot deja constancia de que NO se usó el descubridor canónico — degradar en silencio sería el bug');
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// El reproceso por CARRIL de la story, por repo
// ─────────────────────────────────────────────────────────────────────────────────────────────
const storyVuelta = (id, status, vuelta) => `---\nstory: ${id}\nepic: 1\nstatus: ${status}\n`
  + (vuelta ? 'followed_up_by:\n  - id: X-99\n' : '') + `---\n\n# Story ${id}\n`;

function fixtureCarril(nombre) {
  const { root, repo } = nuevoRepo(nombre);
  // Antes de que el repo empiece a guardar corridas: fuera de la ventana, vuelvan o no.
  escribir(repo, 'specs/a.md', storyVuelta('RK-1', 'done', true));
  escribir(repo, 'specs/b.md', storyVuelta('RK-2', 'done', false));
  commit(repo, 'dos viejas', '2026-05-01T10:00:00-00:00');
  // El repo empieza a guardar corridas.
  escribir(repo, '.advisors/pipeline-runs/RK-3-20260601T1000/findings.json', '[]');
  commit(repo, 'primera corrida guardada', '2026-06-01T10:00:00-00:00');
  escribir(repo, '.advisors/pipeline-runs/RK-4-20260602T1000/review-roster.json', '{}');
  escribir(repo, '.advisors/pipeline-runs/RK-9-20260602T1000/findings.json', '[]');
  escribir(repo, 'specs/c.md', storyVuelta('RK-3', 'done', true));    // con corrida, volvió
  escribir(repo, 'specs/d.md', storyVuelta('RK-4', 'done', false));   // con corrida
  escribir(repo, 'specs/e.md', storyVuelta('RK-5', 'done', true));    // sin constancia, volvió
  escribir(repo, 'specs/f.md', storyVuelta('RK-6', 'done', false));   // sin constancia
  escribir(repo, 'specs/g.md', storyVuelta('RK-9', 'in-progress', false)); // con corrida pero no cerrada
  commit(repo, 'cinco nuevas', '2026-06-02T10:00:00-00:00');
  return { root, repo };
}

test('T14 (2.7) · rework_por_carril separa con corrida / sin constancia, dentro de la ventana, por repo', () => {
  // 🔴 rojo: contar TODO el repo (sin ventana) → las dos viejas entran como «sin constancia»
  //    (den 4 en vez de 2) y el grupo sin corrida parece peor de lo que es por culpa de la historia.
  //    Y el global: sumar entre repos es mezclar productos — el campo NO existe en `global`.
  const { repo } = fixtureCarril('carril-ventana');
  const d = medirJson(repo);
  const x = d.repos[0].rework_por_carril;
  assert.ok(x, `se mide en un repo que guarda corridas: ${JSON.stringify(d.repos[0].not_measured)}`);
  assert.equal(x.desde, '2026-06-01', 'la ventana arranca con la primera corrida guardada');
  assert.deepStrictEqual(x.con_corrida, { num: 1, den: 2 });
  assert.deepStrictEqual(x.sin_constancia, { num: 1, den: 2 });
  assert.equal(x.fuera_de_ventana, 2, 'las dos cerradas antes de la ventana se cuentan aparte');
  assert.strictEqual(d.global.rework_por_carril, undefined, 'nunca se suma entre productos');
});

test('T14b (2.7) · un repo que no guarda corridas publica null con motivo, nunca dos ceros', () => {
  // 🔴 rojo: devolver {con_corrida:{0,0}, sin_constancia:{num,den}} → «nunca pasó nada por el pipeline».
  const { repo } = nuevoRepo('carril-sin-carpeta');
  escribir(repo, 'specs/a.md', storyVuelta('RK-1', 'done', true));
  commit(repo, 'una', '2026-06-02T10:00:00-00:00');
  const d = medirJson(repo);
  assert.strictEqual(d.repos[0].rework_por_carril, null);
  assert.ok((d.repos[0].not_measured || []).some((m) => /carril/i.test(m)), JSON.stringify(d.repos[0].not_measured));
});

test('T14c (2.7) · una carpeta de corrida de OTRA story con prefijo parecido no cuenta', () => {
  // 🔴 rojo: `startsWith(id)` sin el guion → la corrida de RK-10 le da constancia a RK-1.
  const { repo } = nuevoRepo('carril-prefijo');
  escribir(repo, '.advisors/pipeline-runs/RK-10-20260601T1000/findings.json', '[]');
  commit(repo, 'corrida', '2026-06-01T10:00:00-00:00');
  escribir(repo, 'specs/a.md', storyVuelta('RK-1', 'done', false));
  commit(repo, 'story', '2026-06-02T10:00:00-00:00');
  const x = medirJson(repo).repos[0].rework_por_carril;
  assert.deepStrictEqual(x.con_corrida, { num: 0, den: 0 });
  assert.deepStrictEqual(x.sin_constancia, { num: 0, den: 1 });
});

test('T14d (2.7) · un repo sin ningún commit no publica el reproceso por carril: no se pudo leer el árbol', () => {
  // 🔴 rojo: tratar `ls-tree` fallido como «sin carpeta» → el motivo diría «no guarda corridas»,
  //    que es una afirmación sobre el repo, cuando en realidad no se pudo mirar.
  const { repo } = nuevoRepo('carril-sin-commits');
  escribir(repo, 'specs/a.md', storyVuelta('RK-1', 'done', true));
  const d = medirJson(repo);
  const r = d.repos[0];
  assert.strictEqual(r.rework_por_carril, null);
  assert.ok((r.not_measured || []).some((m) => /carril/i.test(m) && /no se pudo leer/i.test(m)), JSON.stringify(r.not_measured));
});

test('T14e (2.7) · una story cerrada ANTES de la ventana y editada después sigue fuera: manda la fecha del cierre, no la del último commit', () => {
  // 🔴 rojo: con «último commit que tocó el archivo» como
  //    fecha de cierre, cualquier story vieja retocada después (un back-link, un typo) entra a la
  //    ventana y cae en «sin constancia» — el grupo sin corrida carga con historia que no le toca.
  const { repo } = nuevoRepo('carril-editada');
  escribir(repo, 'specs/a.md', storyVuelta('RK-1', 'in-progress', false));
  commit(repo, 'nace', '2026-04-20T10:00:00-00:00');
  escribir(repo, 'specs/a.md', storyVuelta('RK-1', 'done', false));
  commit(repo, 'se cierra', '2026-05-01T10:00:00-00:00');
  escribir(repo, '.advisors/pipeline-runs/RK-2-20260601T1000/findings.json', '[]');
  commit(repo, 'primera corrida', '2026-06-01T10:00:00-00:00');
  escribir(repo, 'specs/a.md', storyVuelta('RK-1', 'done', true));   // back-link agregado después
  escribir(repo, 'specs/b.md', storyVuelta('RK-2', 'in-progress', false));
  commit(repo, 'back-link y otra', '2026-06-03T10:00:00-00:00');
  escribir(repo, 'specs/b.md', storyVuelta('RK-2', 'done', false));
  commit(repo, 'cierra la nueva', '2026-06-04T10:00:00-00:00');
  const x = medirJson(repo).repos[0].rework_por_carril;
  assert.equal(x.fuera_de_ventana, 1, `la vieja retocada sigue fuera: ${JSON.stringify(x)}`);
  assert.deepStrictEqual(x.sin_constancia, { num: 0, den: 0 });
  assert.deepStrictEqual(x.con_corrida, { num: 0, den: 1 });
});

test('T14f (2.7) · una story con alguna versión ilegible no se fecha: va a sin_fecha, no a un grupo', () => {
  // 🔴 rojo: con el `status:` ilegible, la fecha de alta caería FUERA de la ventana aunque el cierre real (legible,
  //    con corrida) fuera de adentro → se publicaría `fuera_de_ventana: 1` y nadie sabría por qué.
  const { repo } = nuevoRepo('carril-ilegible');
  escribir(repo, 'specs/a.md', '---\nstory: RK-1\nepic: 1\nstatus:\n---\n\n# x\n');   // estado ilegible (vacío)
  commit(repo, 'nace rota', '2026-05-01T10:00:00-00:00');
  escribir(repo, '.advisors/pipeline-runs/RK-1-20260601T1000/findings.json', '[]');
  commit(repo, 'primera corrida', '2026-06-01T10:00:00-00:00');
  escribir(repo, 'specs/a.md', storyVuelta('RK-1', 'done', false));
  commit(repo, 'se cierra bien', '2026-06-02T10:00:00-00:00');
  const r = medirJson(repo).repos[0];
  const x = r.rework_por_carril;
  assert.equal(x.sin_fecha, 1, `la versión ilegible impide fecharla: ${JSON.stringify(x)} ${JSON.stringify(r.not_measured)}`);
  assert.equal(x.fuera_de_ventana, 0);
  assert.deepStrictEqual(x.con_corrida, { num: 0, den: 0 });
});

test('T14g (2.7) · la corrida de una story con id más largo NO le da constancia a la de id más corto', () => {
  // 🔴 rojo: con `startsWith(id + '-')`, la carpeta
  //    `1.3-B-20260601T1000` le da constancia a la story `1.3`. La carpeta es `<id>-<fecha>`: después del
  //    guion tiene que venir la fecha.
  const { repo } = nuevoRepo('carril-prefijo-largo');
  escribir(repo, '.advisors/pipeline-runs/RK-1-B-20260601T1000/findings.json', '[]');
  commit(repo, 'corrida de RK-1-B', '2026-06-01T10:00:00-00:00');
  escribir(repo, 'specs/a.md', storyVuelta('RK-1', 'done', false));
  escribir(repo, 'specs/b.md', storyVuelta('RK-1-B', 'done', false));
  commit(repo, 'dos', '2026-06-02T10:00:00-00:00');
  const x = medirJson(repo).repos[0].rework_por_carril;
  assert.deepStrictEqual(x.con_corrida, { num: 0, den: 1 }, JSON.stringify(x));
  assert.deepStrictEqual(x.sin_constancia, { num: 0, den: 1 });
});

