'use strict';

/**
 * guide-links.test.js — las guías movidas a su nombre en inglés no dejan nada roto.
 *
 * Una guía que se mueve deja un reemplazo de dos líneas en su ruta vieja, y su contenido no cambia en el commit que la
 * mueve. Lo que se puede romper sin que nadie lo vea:
 *   - T4: un reemplazo que apunta a una guía que no existe, o que no es el que genera `--write-shims` (quien abre la
 *     ruta vieja lee «movida a…» y no encuentra nada);
 *   - T17: una guía que se reescribió en el mismo commit que la movió (git deja de seguir su historial);
 *   - T1: un enlace relativo de una guía, del índice o de una portada que no lleva a ningún archivo;
 *   - T2: una ruta `guides/…` nombrada que lleva a una guía que no existe (mide sólo con el privado en el árbol: las
 *     guías públicas nombran guías que viven ahí).
 *
 * Las rutas salen del mapa (`scripts/lib/renames.json`, las entradas de guías de esta mudanza), nunca escritas acá. La
 * copia pública no lleva el mapa: ahí la prueba dice NO MEDIDO, como `guides-moved.test.js`. Los reemplazos viven en el
 * privado (el arnés instalado trae el mapa con la capa del equipo, pero no los reemplazos), así que T4 mide sólo donde
 * está el privado: el árbol armado. T17 necesita además el historial de git de la guía: se corre en la copia pública
 * pasándole el mapa del privado con TYCON_LEGACY_NAMES_MAP.
 *
 * Los commits del laboratorio llevan GIT_AUTHOR_DATE y GIT_COMMITTER_DATE fijos y el mantenimiento automático de git
 * apagado; el resto sólo lee el historial con `git log` y `git show`.
 *
 * Correr: node --test scripts/tests/guide-links.test.js
 *         TYCON_LEGACY_NAMES_MAP=<privado>/scripts/lib/renames.json node --test scripts/tests/guide-links.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const MAP = process.env.TYCON_LEGACY_NAMES_MAP || path.join(ROOT, 'scripts', 'lib', 'renames.json');
const NOT_MEASURED = !fs.existsSync(MAP) && 'NO MEDIDO — copia pública sin el mapa (TYCON_LEGACY_NAMES_MAP lo pasa)';
/** Sin el privado en el árbol no hay reemplazos que medir; lo marca `.tycon/internal-forms.json`, que sólo vive ahí. */
function shimsElsewhere(root) {
  return !fs.existsSync(path.join(root, '.tycon', 'internal-forms.json'))
    && 'NO MEDIDO — los reemplazos de las guías viven en el privado: corre sobre el árbol armado';
}
const SHIMS_ELSEWHERE = !NOT_MEASURED && shimsElsewhere(ROOT);
const L = require(path.join(ROOT, 'scripts', 'lib', 'legacy-names.js'));

/** Las guías movidas a su nombre en inglés: entradas de archivo de `guides/` con su batch. Con el mapa y sin ninguna, falla. */
function movedGuides() {
  const all = JSON.parse(fs.readFileSync(MAP, 'utf8')).entries
    .filter((e) => e && e.kind === 'file' && /^8\.45\b/.test(String(e.batch || '')) && /^guides\/.+\.md$/.test(e.old));
  assert.ok(all.length > 0, 'el mapa no tiene guías movidas a su nombre en inglés');
  return all;
}

/** Los reemplazos que hay en `guides/` (en cualquier subcarpeta), como rutas relativas a la raíz. */
function shimsInGuides(dir = path.join(ROOT, 'guides')) {
  const out = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, d.name);
    if (d.isDirectory()) out.push(...shimsInGuides(abs));
    else if (d.name.endsWith('.md') && L.isShim(fs.readFileSync(abs, 'utf8'))) out.push(path.relative(ROOT, abs).split(path.sep).join('/'));
  }
  return out;
}

test('T4 Reemplazos_ApuntanALaNueva @story-8.45 @ac-5 — cada ruta vieja es el reemplazo generado y lleva a la guía nueva', { skip: NOT_MEASURED || SHIMS_ELSEWHERE }, () => {
  for (const e of movedGuides()) {
    const oldAbs = path.join(ROOT, e.old);
    const newAbs = path.join(ROOT, e.new);
    assert.ok(fs.existsSync(newAbs), `${e.new}: la guía nueva existe`);
    assert.ok(!L.isShim(fs.readFileSync(newAbs, 'utf8')), `${e.new}: es la guía, no un reemplazo`);
    assert.ok(fs.existsSync(oldAbs), `${e.old}: la ruta vieja deja su reemplazo`);
    const text = fs.readFileSync(oldAbs, 'utf8');
    assert.ok(L.isGeneratedShim(e.old, text), `${e.old}: es el reemplazo que escribe --write-shims, no uno a mano`);
    assert.strictEqual(text.replace(/\n$/, '').split('\n').length, 2, `${e.old}: dos líneas`);
    assert.strictEqual(L.shimTarget(oldAbs), newAbs, `${e.old}: la marca lleva a ${e.new}`);
    const link = /\]\(([^)]+)\)/.exec(text);
    assert.ok(link, `${e.old}: trae un enlace`);
    assert.strictEqual(path.resolve(path.dirname(oldAbs), link[1]), newAbs, `${e.old}: el enlace relativo resuelve a ${e.new}`);
  }
  // y al revés: cada reemplazo de una guía tiene su entrada en el mapa (si se pierde una, su reemplazo queda huérfano)
  const enMapa = new Set(JSON.parse(fs.readFileSync(MAP, 'utf8')).entries.filter((e) => e && e.kind === 'file').map((e) => e.old));
  const huerfanos = shimsInGuides().filter((rel) => !enMapa.has(rel));
  assert.deepStrictEqual(huerfanos, [], 'reemplazos de guías sin su entrada en el mapa');
});

function git(root, args) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.ok(!r.error && r.status === 0, `git ${args.join(' ')} falló: ${(r.error && r.error.message) || r.stderr}`);
  return r.stdout;
}
/** Los renombres de la ruta nueva siguiendo su historial: { commit, from, to } por cada uno. Sin renombres, []. */
function renamesOf(root, rel) {
  const out = [];
  let commit = null;
  for (const l of git(root, ['log', '--follow', '-M', '--name-status', '--format=%H', '--', rel]).split('\n')) {
    if (/^[0-9a-f]{40}$/.test(l)) commit = l;
    const m = /^R\d+\t([^\t]+)\t([^\t]+)$/.exec(l);
    if (m) out.push({ commit, from: m[1], to: m[2] });
  }
  return out;
}

/**
 * Lo que dejó el commit que movió cada guía. → { problemas, sinHistorial }. Un renombre que git sigue se compara
 * renglón por renglón (un enlace a otra guía movida puede cambiar). Sin renombre, se mira el commit que agregó la ruta
 * nueva: si en ese mismo commit se borró la vieja, la guía se reescribió al moverla y git perdió el renombre (problema);
 * si no, este árbol no tiene el movimiento (un árbol armado parado en el otro repo) y no se mide.
 */
function movesProblems(root, moved) {
  const aViejo = (s) => moved.reduce((acc, e) => acc.split(path.posix.basename(e.new)).join(path.posix.basename(e.old)), s);
  const problemas = [];
  const sinHistorial = [];
  for (const e of moved) {
    const move = renamesOf(root, e.new).find((h) => h.from === e.old && h.to === e.new);
    if (!move) {
      const alta = git(root, ['log', '--diff-filter=A', '--format=%H', '--', e.new]).split('\n').filter(Boolean).pop();
      const borroLaVieja = alta && git(root, ['show', '--name-status', '--format=', alta]).split('\n').includes(`D\t${e.old}`);
      if (borroLaVieja) problemas.push(`${e.new}: el commit que la movió la reescribió tanto que git perdió el renombre desde ${e.old}`);
      else sinHistorial.push(e.new);
      continue;
    }
    const antes = git(root, ['show', `${move.commit}^:${e.old}`]).split('\n');
    const despues = git(root, ['show', `${move.commit}:${e.new}`]).split('\n');
    if (despues.length !== antes.length) { problemas.push(`${e.new}: el commit que la movió agregó o sacó renglones`); continue; }
    const distintos = despues.map((l, i) => i).filter((i) => despues[i] !== antes[i] && aViejo(despues[i]) !== antes[i]);
    if (distintos.length) problemas.push(`${e.new}: renglones reescritos en el commit que la movió: ${distintos.map((i) => i + 1).join(', ')}`);
  }
  return { problemas, sinHistorial };
}
// sólo «la raíz no es un repo» se saltea; git ausente o cualquier otro error de git falla en T17
const REV_PARSE = spawnSync('git', ['-C', ROOT, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' });
const NO_GIT = !REV_PARSE.error && REV_PARSE.status !== 0 && /not a git repository/i.test(REV_PARSE.stderr || '')
  && 'NO MEDIDO — sin historial de git en la raíz';

test('T17 Contenido_IgualAlDeAntes @story-8.45 @ac-4 — el commit que mueve cada guía no cambia su texto, salvo los enlaces a otra guía movida', { skip: NOT_MEASURED || NO_GIT }, (t) => {
  assert.ok(!REV_PARSE.error && REV_PARSE.status === 0, `git no pudo mirar la raíz: ${(REV_PARSE.error && REV_PARSE.error.message) || REV_PARSE.stderr}`);
  const moved = movedGuides();
  const { problemas, sinHistorial } = movesProblems(ROOT, moved);
  assert.deepStrictEqual(problemas, []);
  t.diagnostic(`medidas ${moved.length - sinHistorial.length} de ${moved.length} guías movidas`);
  // una guía sin el movimiento en este árbol no se mide, y se dice; si ninguna lo tiene, la prueba entera queda NO MEDIDA
  if (sinHistorial.length) t.skip(`NO MEDIDO para ${sinHistorial.join(', ')}: este árbol no tiene el commit que la movió`);
});

// Laboratorio de T17 y T4: un repo de juguete con fechas fijas y sin el mantenimiento automático de git.
function labRepo() {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'guide-links-'));
  const env = { ...process.env, GIT_AUTHOR_DATE: '2001-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2001-01-01T00:00:00Z',
    GIT_AUTHOR_NAME: 'lab', GIT_AUTHOR_EMAIL: 'lab@example.invalid', GIT_COMMITTER_NAME: 'lab', GIT_COMMITTER_EMAIL: 'lab@example.invalid' };
  const run = (...args) => {
    const r = spawnSync('git', ['-C', dir, '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', env });
    assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  };
  run('init', '-q', '-b', 'main');
  return { dir, run, write: (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); } };
}
const lineas = (prefijo, n) => Array.from({ length: n }, (_, i) => `${prefijo} renglón ${i + 1} con texto propio para que git compare`).join('\n') + '\n';

test('T17 laboratorio — una guía reescrita entera al moverla falla; una movida igual pasa; una sin su movimiento no se mide', () => {
  const lab = labRepo();
  lab.write('guides/vieja-a.md', lineas('a', 20));
  lab.write('guides/vieja-b.md', lineas('b', 20));
  lab.run('add', '-A'); lab.run('commit', '-q', '-m', 'guías');
  lab.run('mv', 'guides/vieja-a.md', 'guides/new-a.md');
  lab.run('mv', 'guides/vieja-b.md', 'guides/new-b.md');
  lab.write('guides/new-a.md', lineas('otra', 20));
  lab.write('guides/sin-movimiento.md', lineas('c', 5));
  lab.run('add', '-A'); lab.run('commit', '-q', '-m', 'mover');
  const e = (viejo, nuevo) => ({ kind: 'file', old: `guides/${viejo}.md`, new: `guides/${nuevo}.md`, batch: '8.45-Z' });
  const r = movesProblems(lab.dir, [e('vieja-a', 'new-a'), e('vieja-b', 'new-b'), e('nunca-estuvo', 'sin-movimiento')]);
  assert.strictEqual(r.problemas.length, 1, JSON.stringify(r));
  assert.match(r.problemas[0], /new-a\.md: el commit que la movió la reescribió tanto que git perdió el renombre/);
  assert.deepStrictEqual(r.sinHistorial, ['guides/sin-movimiento.md']);
  fs.rmSync(lab.dir, { recursive: true, force: true });
});

/** Los archivos de texto de una carpeta, en cualquier subcarpeta, como rutas relativas a `root`. */
function filesUnder(root, rel) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return [];
  if (!fs.statSync(abs).isDirectory()) return [rel];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((d) => filesUnder(root, path.posix.join(rel, d.name)));
}

/**
 * Las menciones de una ruta vieja de guía movida en `files` (rutas relativas a `root`): la ruta escrita entera
 * (`guides/vieja.md`) o un enlace relativo de markdown que resuelve a ella. → ['archivo: ruta vieja', …]
 */
function oldGuideMentions(root, files, moved) {
  const out = [];
  for (const rel of files) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    for (const e of moved) {
      if (text.includes(e.old)) { out.push(`${rel}: ${e.old}`); continue; }
      const oldAbs = path.join(root, e.old);
      for (const m of text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
        if (/^[a-z]+:/i.test(m[1])) continue;
        if (path.resolve(path.dirname(path.join(root, rel)), m[1]) === oldAbs) { out.push(`${rel}: ${e.old} (enlace ${m[1]})`); break; }
      }
    }
  }
  return out;
}

test('T8 Index_SinNombresViejos @story-8.45 @ac-7 — INDEX y las portadas nombran cada guía movida por su ruta nueva', { skip: NOT_MEASURED }, () => {
  assert.deepStrictEqual(oldGuideMentions(ROOT, ['INDEX.md', 'README.md', 'README.es.md'].filter((f) => fs.existsSync(path.join(ROOT, f))), movedGuides()), []);
});

test('T9 Claude_BloquesNombranLaNueva @story-8.45 @ac-9 — los bloques del CLAUDE.md global no nombran una guía por su ruta vieja', { skip: NOT_MEASURED }, () => {
  const blocks = filesUnder(ROOT, 'claude-md-blocks');
  assert.ok(blocks.length > 0, 'no encontré los bloques de claude-md-blocks/');
  assert.deepStrictEqual(oldGuideMentions(ROOT, blocks, movedGuides()), []);
});

test('T15 Comandos_ImprimenLaRutaNueva @story-8.45 @ac-14 — pipeline.js, harness.js y los ganchos citan cada guía movida por su ruta nueva', { skip: NOT_MEASURED }, () => {
  const scripts = ['skills/tycon-pipeline/scripts/pipeline.js', 'scripts/setup/harness.js', ...filesUnder(ROOT, 'scripts/hooks').filter((f) => f.endsWith('.js'))];
  for (const f of scripts.slice(0, 2)) assert.ok(fs.existsSync(path.join(ROOT, f)), `${f}: existe`);
  assert.deepStrictEqual(oldGuideMentions(ROOT, scripts, movedGuides()), []);
});

test('T8, T9 y T15 laboratorio — una ruta vieja escrita entera o enlazada se encuentra; la nueva no', () => {
  const lab = fs.mkdtempSync(path.join(require('os').tmpdir(), 'guide-links-t8-'));
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(lab, rel)), { recursive: true }); fs.writeFileSync(path.join(lab, rel), text); };
  write('INDEX.md', '| x | `guides/vieja.md` |\n');
  // un enlace externo con la ruta vieja también queda roto (la guía ya no está ahí)
  write('README.md', 'ver [afuera](https://example.invalid/blob/main/guides/vieja.md)\n');
  write('README.es.md', 'ver [la guía](guides/new.md) y [otra](guides/new.md#parte)\n');
  write('claude-md-blocks/a/b.md', 'lee [esto](../../guides/vieja.md)\n');
  // un enlace relativo corto, desde la misma carpeta, no trae la ruta entera: se resuelve
  write('guides/otra.md', 'ver [la vieja](vieja.md#parte) y [la nueva](new.md)\n');
  const moved = [{ kind: 'file', old: 'guides/vieja.md', new: 'guides/new.md', batch: '8.45-Z' }];
  assert.deepStrictEqual(oldGuideMentions(lab, ['INDEX.md', 'README.md', 'README.es.md', ...filesUnder(lab, 'claude-md-blocks'), 'guides/otra.md'], moved), [
    'INDEX.md: guides/vieja.md',
    'README.md: guides/vieja.md',
    'claude-md-blocks/a/b.md: guides/vieja.md',
    'guides/otra.md: guides/vieja.md (enlace vieja.md)',
  ]);
  fs.rmSync(lab, { recursive: true, force: true });
});

test('T4 laboratorio — sin el privado en el árbol (el arnés instalado trae el mapa pero no los reemplazos) no se mide', () => {
  const lab = fs.mkdtempSync(path.join(require('os').tmpdir(), 'guide-links-t4-'));
  fs.mkdirSync(path.join(lab, 'scripts', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(lab, 'scripts', 'lib', 'renames.json'), '{"entries":[]}');
  assert.match(String(shimsElsewhere(lab)), /NO MEDIDO/, 'con el mapa y sin el privado: no medido');
  fs.mkdirSync(path.join(lab, '.tycon'));
  fs.writeFileSync(path.join(lab, '.tycon', 'internal-forms.json'), '{}');
  assert.strictEqual(shimsElsewhere(lab), false, 'con el privado: mide');
  fs.rmSync(lab, { recursive: true, force: true });
});

// ── T1 y T2: ningún enlace ni mención de una guía apunta a nada ───────────────────────────────────────────────────────
// Se miran las guías (`guides/`, `getting-started/`), el índice y las portadas. Un bloque de código no cuenta: ahí van
// ejemplos de comandos.
const PORTADAS = ['INDEX.md', 'README.md', 'README.es.md', 'INSTALL.md'];
/** Lo que no se mide, con su motivo: los registros históricos nombran las guías como se llamaban en su fecha, y unos
 *  ejemplos nombran una guía inventada. */
const MENCIONES_EXCEPTUADAS = [
  { archivo: 'guides/maintaining/incident-log.md', motivo: 'registro histórico: cada caso nombra las guías como se llamaban ese día' },
  { archivo: 'guides/guide-update-proposals.md', motivo: 'registro histórico: cada propuesta nombra las guías como se llamaban ese día' },
  { archivo: 'INSTALL.md', mencion: 'guides/nueva-guia.md', motivo: 'ejemplo de cómo se agrega una guía nueva' },
  { archivo: 'INSTALL.md', mencion: 'guides/X.md', motivo: 'ejemplo de un puntero a una guía' },
];
const PRIVATE_ABSENT = !fs.existsSync(path.join(ROOT, '.tycon', 'internal-forms.json'))
  && 'NO MEDIDO — las guías públicas nombran guías que viven en el privado: corre sobre el árbol armado';

/** Los `.md` que se miran, relativos a `root`. */
function archivosConEnlaces(root) {
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.name.endsWith('.md')) out.push(path.relative(root, abs).split(path.sep).join('/'));
    }
  };
  walk(path.join(root, 'guides'));
  walk(path.join(root, 'getting-started'));
  for (const f of PORTADAS) if (fs.existsSync(path.join(root, f))) out.push(f);
  return out.sort();
}

/** ¿Existe la ruta con estas mismas mayúsculas? En macOS y Windows el disco no las distingue, pero en Linux (la CI) un
 *  enlace con otra mayúscula no abre: se compara cada tramo contra el nombre real de la carpeta. */
function existeTal(root, abs) {
  if (!fs.existsSync(abs)) return false;
  const tramos = path.relative(root, abs).split(path.sep).filter(Boolean);
  let dir = root;
  for (const t of tramos) {
    if (t === '..') { dir = path.dirname(dir); continue; }
    let nombres;
    try { nombres = fs.readdirSync(dir); } catch (_) { return true; }   // una carpeta que no se lista: vale lo que dijo el disco
    if (!nombres.includes(t)) return false;
    dir = path.join(dir, t);
  }
  return true;
}

/** Los enlaces relativos que no resuelven y las menciones `guides/….md` que no existen: `{ enlaces, menciones }`, cada
 *  uno `archivo:renglón → destino`. Las menciones exceptuadas no cuentan. Lo que no se mira (anotado por el pase
 *  adversarial): `<a href>` en HTML, un destino con espacios o paréntesis, y una mención en texto con `./` o `../`. */
function rotos(root) {
  const enlaces = [];
  const menciones = [];
  for (const rel of archivosConEnlaces(root)) {
    // un bloque de código (``` o ~~~) no cuenta: se vacía sin mover los renglones
    const texto = fs.readFileSync(path.join(root, rel), 'utf8')
      .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, (m) => m.replace(/[^\n]/g, ' '));
    texto.split('\n').forEach((linea, i) => {
      const destinos = [...linea.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((m) => m[1]);
      // el enlace de referencia: `[nombre]: destino` al principio del renglón
      const ref = /^ {0,3}\[[^\]]+\]:\s+(\S+)/.exec(linea);
      if (ref) destinos.push(ref[1].replace(/^<|>$/g, ''));
      for (const destino of destinos) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(destino) || destino.startsWith('#') || destino.startsWith('<')) continue;
        const sinAncla = destino.split('#')[0].split('?')[0];
        let ruta;
        try { ruta = decodeURIComponent(sinAncla); } catch (_) { ruta = sinAncla; }
        if (!ruta) continue;
        const abs = ruta.startsWith('/') ? path.join(root, ruta) : path.resolve(path.dirname(path.join(root, rel)), ruta);
        if (!existeTal(root, abs)) enlaces.push(`${rel}:${i + 1} → ${destino}`);
      }
      for (const m of linea.matchAll(/(?<![\w./-])guides\/[\w./-]+?\.md\b/g)) {
        if (fs.existsSync(path.join(root, m[0]))) continue;
        if (MENCIONES_EXCEPTUADAS.some((x) => x.archivo === rel && (!x.mencion || x.mencion === m[0]))) continue;
        menciones.push(`${rel}:${i + 1} → ${m[0]}`);
      }
    });
  }
  return { enlaces, menciones };
}

test('T1 Enlaces_NingunoRoto @story-8.45 @ac-11 — cada enlace relativo de las guías, el índice y las portadas lleva a un archivo que existe', () => {
  const { enlaces } = rotos(ROOT);
  assert.deepStrictEqual(enlaces, [], `enlaces rotos:\n${enlaces.join('\n')}`);
});

test('T2 Menciones_NoApuntanAUnaViejaFueraDelMapa @story-8.45 @ac-8 @ac-11 — ninguna ruta guides/… nombrada lleva a una guía que no existe', { skip: PRIVATE_ABSENT }, () => {
  const { menciones } = rotos(ROOT);
  assert.deepStrictEqual(menciones, [], `menciones a guías que no existen (una guía movida deja su reemplazo; si es historia, va en MENCIONES_EXCEPTUADAS con su motivo):\n${menciones.join('\n')}`);
});

test('T1 laboratorio — un enlace y una mención a una guía que no existe fallan nombrándolos; lo exceptuado y un bloque de código no', () => {
  const lab = fs.mkdtempSync(path.join(require('os').tmpdir(), 'guide-links-t1-'));
  try {
    fs.mkdirSync(path.join(lab, 'guides', 'maintaining'), { recursive: true });
    fs.writeFileSync(path.join(lab, 'guides', 'existe.md'), '# existe\n');
    fs.writeFileSync(path.join(lab, 'guides', 'a.md'), [
      '[bien](existe.md) [ancla](#x) [afuera](https://example.com/x.md)',
      '[roto](no-existe.md#algo)',
      'Ver `guides/existe.md` y `guides/borrada.md`.',
      '```', '[en un bloque](tampoco.md) guides/en-un-bloque.md', '```',
      '~~~', '[en otro bloque](tampoco.md)', '~~~',
      '[con consulta](existe.md?x=1) [otra mayúscula](Existe.md)',
      '[ref]: referencia-rota.md',
    ].join('\n'));
    fs.writeFileSync(path.join(lab, 'guides', 'maintaining', 'incident-log.md'), 'El caso nombraba guides/vieja.md.\n');
    fs.writeFileSync(path.join(lab, 'INDEX.md'), '| algo | [guía](guides/existe.md) | [rota](guides/falta.md) |\n');
    fs.writeFileSync(path.join(lab, 'INSTALL.md'), 'Agregá `guides/nueva-guia.md` y mirá `guides/otra-inventada.md`.\n');
    assert.deepStrictEqual(rotos(lab), {
      // la mayúscula distinta cuenta como rota: en un disco que las distingue (Linux) no abre
      enlaces: ['INDEX.md:1 → guides/falta.md', 'guides/a.md:2 → no-existe.md#algo', 'guides/a.md:10 → Existe.md', 'guides/a.md:11 → referencia-rota.md'],
      // el ejemplo exceptuado de INSTALL.md no cuenta; otra mención del mismo archivo sí, y la del índice también
      menciones: ['INDEX.md:1 → guides/falta.md', 'INSTALL.md:1 → guides/otra-inventada.md', 'guides/a.md:3 → guides/borrada.md'],
    });
  } finally { fs.rmSync(lab, { recursive: true, force: true }); }
});
