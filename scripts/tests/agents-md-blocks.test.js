'use strict';
// agents-md-blocks.test.js — `~/.codex/AGENTS.md` armado desde los bloques del arnés.
//
// Lo que no se puede perder:
//   · los bloques de `claude-md-blocks/` quedan ENTRE SUS MARCAS, con la variante `names/<bloque>.codex.md` donde existe;
//   · lo que la persona escribió fuera de las marcas queda byte a byte;
//   · NO depende de `~/.claude/CLAUDE.md`: ni lo lee ni copia lo suyo;
//   · no escribe ningún `@import` (Codex no los resuelve);
//   · un bloque con su integración apagada o fuera del perfil no se agrega, y si estaba se quita; «no se pudo saber» no
//     es «apagada» (lo que falta no se agrega, lo que está queda y se actualiza);
//   · es idempotente, y `--check` no escribe.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const MODULE = path.join(ROOT, 'scripts', 'setup', 'agents-md-blocks.js');
const A = () => require(MODULE);

function lab() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-md-'));
  const blocks = path.join(dir, 'claude-md-blocks');
  fs.mkdirSync(path.join(blocks, 'names'), { recursive: true });
  fs.writeFileSync(path.join(blocks, 'style.md'), '# Estilo\nregla de estilo\n');
  fs.writeFileSync(path.join(blocks, 'tool-names.md'), '# Nombres (lado Claude)\nAskUserQuestion\n');
  fs.writeFileSync(path.join(blocks, 'names', 'tool-names.codex.md'), '# Nombres (lado Codex)\nrequest_user_input\n');
  fs.writeFileSync(path.join(blocks, 'clock.md'), '<!-- requires-integration: clockify -->\n# Reloj\nregla del reloj\n');
  fs.writeFileSync(path.join(blocks, 'brakes.md'), '<!-- requires-profile: full -->\n# Frenos\nregla de los frenos\n');
  return { dir, blocks, target: path.join(dir, 'codex', 'AGENTS.md') };
}
const ON = { clockify: true };
const run = (l, extra = {}) => A().sync(Object.assign({ blocksDir: l.blocks, target: l.target, integrations: ON, profile: 'full', quiet: true }, extra));
const read = (f) => fs.readFileSync(f, 'utf8');
const startOf = (name) => `<!-- TYCON_BLOCK:${name} START`;
const endOf = (name) => `<!-- TYCON_BLOCK:${name} END -->`;
const between = (text, name) => { const i = text.indexOf(startOf(name)); const j = text.indexOf(endOf(name), i); return i === -1 || j === -1 ? null : text.slice(text.indexOf('\n', i) + 1, j); };

test('perfil minimal: el bloque del índice del arnés está igual, con la ruta del árbol, su INDEX.md y las skills', () => {
  // Codex no resuelve el @import con que Claude Code carga el índice: sin este bloque, una máquina sólo con Codex en el
  // perfil minimal arrancaba con un AGENTS.md sin nada del arnés, y el modelo no encontraba ni el índice ni las skills
  const l = lab();
  fs.writeFileSync(path.join(l.dir, 'INDEX.md'), '# Índice\n');
  // una HOME que no contiene el árbol: su ruta sale entera; las skills (bajo esa HOME) salen con `~`
  const minimal = { integrations: { clockify: false }, profile: 'minimal', tree: l.dir, home: path.join(l.dir, 'otra-casa'), env: {} };
  run(l, minimal);
  const cuerpo = between(read(l.target), 'harness-index');
  assert.ok(cuerpo, 'el bloque del índice está en el perfil minimal');
  assert.ok(cuerpo.includes(`${l.dir.split(path.sep).join('/')}/INDEX.md`), 'nombra el INDEX.md del árbol instalado');
  assert.ok(cuerpo.includes('`~/.codex/skills/tycon-pipeline/SKILL.md`'), 'dice dónde está la skill del pipeline');
  assert.ok(!cuerpo.includes('@'), 'ningún @import: Codex no lo resuelve');
  assert.ok(!between(read(l.target), 'brakes'), 'los bloques de full siguen sin agregarse');
  assert.strictEqual(run(l, minimal).changed, false, 'idempotente');
});

test('el bloque del índice nombra las skills de CODEX_HOME y abrevia con ~ lo que cuelga de HOME', () => {
  const l = lab();
  fs.writeFileSync(path.join(l.dir, 'INDEX.md'), '# Índice\n');
  run(l, { tree: l.dir, home: l.dir, env: { CODEX_HOME: path.join(l.dir, 'codex-propio') } });
  const cuerpo = between(read(l.target), 'harness-index');
  assert.ok(cuerpo.includes('`~/INDEX.md`'), 'el índice, abreviado');
  assert.ok(cuerpo.includes('`~/codex-propio/skills/tycon-pipeline/SKILL.md`'), 'las skills, en CODEX_HOME');
});

test('IndiceEntero_VaAdentroDelBloque: el bloque del índice trae el INDEX.md entero, no sólo su ruta', () => {
  // Codex no expande las líneas `@` del AGENTS.md: si el bloque sólo nombra el índice, el modelo tiene que ir a leerlo,
  // y en la medición de 319 sesiones de Codex el índice nunca llegó a su contexto
  const l = lab();
  fs.writeFileSync(path.join(l.dir, 'INDEX.md'), '# Índice de guías\n\n| Trabajando en... | Leer |\n|---|---|\n| Commit | `guides/git.md` |\n');
  run(l, { tree: l.dir, home: path.join(l.dir, 'otra-casa'), env: {} });
  const cuerpo = between(read(l.target), 'harness-index');
  assert.ok(cuerpo.includes('| Commit | `guides/git.md` |'), 'la fila del índice está adentro del bloque');
  assert.ok(cuerpo.includes('# Índice de guías'), 'con su título');
  assert.ok(cuerpo.includes('`~/.codex/skills/tycon-pipeline/SKILL.md`'), 'y sigue diciendo dónde está el pipeline');
  assert.ok(cuerpo.includes('relativas'), 'y que sus rutas son relativas a la carpeta del arnés');
});

test('IndiceConArroba_NoEscribeImport: una línea del índice que empieza con @ no se copia', () => {
  const l = lab();
  fs.writeFileSync(path.join(l.dir, 'INDEX.md'), '# Índice\n@guides/otra.md\nfila normal con correo a@b.c\n');
  run(l, { tree: l.dir, env: {} });
  const cuerpo = between(read(l.target), 'harness-index');
  assert.ok(!/^@/m.test(cuerpo), 'ninguna línea empieza con @');
  assert.ok(cuerpo.includes('fila normal con correo a@b.c'), 'lo demás del índice queda, aunque tenga una @ en el medio');
});

test('IndiceCambia_ElBloqueSeActualiza: al cambiar el INDEX.md, la próxima sincronización lo reescribe', () => {
  const l = lab();
  fs.writeFileSync(path.join(l.dir, 'INDEX.md'), '# Índice\nversión uno\n');
  run(l, { tree: l.dir, env: {} });
  assert.strictEqual(run(l, { tree: l.dir, env: {} }).changed, false, 'sin cambios, no reescribe');
  fs.writeFileSync(path.join(l.dir, 'INDEX.md'), '# Índice\nversión dos\n');
  assert.strictEqual(run(l, { tree: l.dir, env: {} }).changed, true, 'con el índice cambiado, reescribe');
  const cuerpo = between(read(l.target), 'harness-index');
  assert.ok(cuerpo.includes('versión dos') && !cuerpo.includes('versión uno'), 'queda el índice nuevo');
});

test('ImportacionesNoExpandidas_Declaradas: el inventario de diferencias dice que Codex no expande las líneas @', () => {
  const inv = read(path.join(ROOT, 'guides', 'maintaining', 'codex-divergence-inventory.md'));
  assert.ok(/no expande las líneas `@`/.test(inv), 'declara que Codex no expande las importaciones del AGENTS.md');
  assert.ok(/índice.*entero/i.test(inv), 'y que el arnés escribe el índice entero adentro');
});

test('sin INDEX.md en el árbol: el bloque del índice no se escribe, se saca si estaba, y se avisa', () => {
  const l = lab();
  fs.writeFileSync(path.join(l.dir, 'INDEX.md'), '# Índice\n');
  run(l, { tree: l.dir });
  assert.ok(between(read(l.target), 'harness-index'), 'con el índice, está');
  fs.rmSync(path.join(l.dir, 'INDEX.md'));
  const r = run(l, { tree: l.dir });
  assert.ok(!read(l.target).includes(startOf('harness-index')), 'sin el índice, se saca entre sus marcas');
  assert.ok(r.lines.some((x) => /sin el bloque del índice/.test(x)), 'y lo dice');
  assert.ok(between(read(l.target), 'style'), 'lo demás queda');
});

test('sin AGENTS.md: lo crea con cada bloque entre sus marcas, la variante de Codex y ningún @import', () => {
  const l = lab();
  const r = run(l);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.changed, true);
  const t = read(l.target);
  for (const name of ['style', 'tool-names', 'clock', 'brakes']) {
    assert.ok(t.includes(startOf(name)) && t.includes(endOf(name)), `falta el bloque ${name}`);
  }
  assert.match(between(t, 'style'), /regla de estilo/);
  assert.match(between(t, 'tool-names'), /request_user_input/, 'el bloque con variante lleva el cuerpo de Codex');
  assert.doesNotMatch(t, /AskUserQuestion/, 'el cuerpo del lado Claude no llega a Codex');
  assert.doesNotMatch(t, /requires-integration|requires-profile/, 'los marcadores de condición no se copian');
  assert.ok(!t.split('\n').some((line) => line.startsWith('@')), 'ningún renglón es un @import');
});

test('lo de la persona fuera de las marcas queda byte a byte, antes, entre y después', () => {
  const l = lab();
  fs.mkdirSync(path.dirname(l.target), { recursive: true });
  const before = '# Mis reglas\n\ncosas mías, con  dos espacios y\ttab\n';
  fs.writeFileSync(l.target, before);
  run(l);
  const once = read(l.target);
  assert.ok(once.startsWith(before.replace(/\n+$/, '\n')), 'lo de antes sigue al principio');
  // la persona agrega texto ENTRE dos bloques y al final, y cambia el canónico
  const i = once.indexOf(startOf('tool-names'));
  const edited = `${once.slice(0, i)}nota entre bloques\n\n${once.slice(i)}\ncola de la persona\n`;
  fs.writeFileSync(l.target, edited);
  fs.writeFileSync(path.join(l.blocks, 'style.md'), '# Estilo\nregla de estilo NUEVA\n');
  const r = run(l);
  assert.strictEqual(r.changed, true);
  const t = read(l.target);
  assert.match(between(t, 'style'), /regla de estilo NUEVA/);
  assert.ok(t.includes('cosas mías, con  dos espacios y\ttab\n'), 'lo de antes, intacto');
  assert.ok(t.includes('nota entre bloques\n\n<!-- TYCON_BLOCK:tool-names START'), 'lo de entre bloques, intacto y en su lugar');
  assert.ok(t.endsWith('\ncola de la persona\n'), 'lo del final, intacto');
  // quitando los bloques, lo que queda es lo de la persona tal cual
  const outside = (s) => s.replace(/<!-- TYCON_BLOCK:([\w-]+) START[\s\S]*?<!-- TYCON_BLOCK:\1 END -->/g, '«»');
  assert.strictEqual(outside(t), outside(edited));
});

test('no depende de CLAUDE.md: no lo lee ni copia lo suyo', () => {
  const l = lab();
  const claude = path.join(l.dir, 'claude', 'CLAUDE.md');
  fs.mkdirSync(path.dirname(claude), { recursive: true });
  fs.writeFileSync(claude, '# Lo personal de Claude\nTEXTO-SÓLO-DE-CLAUDE\n@~/algo/README.md\n');
  const r = spawnSync(process.execPath, [MODULE, '--blocks', l.blocks, '--target', l.target], {
    encoding: 'utf8', env: Object.assign({}, process.env, { HOME: l.dir, USERPROFILE: l.dir, CLAUDE_MD_PATH: claude, TYCON_PROFILE: '0', TYCON_CLOCKIFY: '1', TYCON_INSTALL_PROFILE: 'full' }),
  });
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  const t = read(l.target);
  assert.doesNotMatch(t, /TEXTO-SÓLO-DE-CLAUDE/);
  assert.ok(!t.split('\n').some((line) => line.startsWith('@')));
  assert.ok(t.includes(startOf('style')) && t.includes(startOf('clock')), 'por línea de comandos escribe los bloques (con la integración prendida por su variable)');
  assert.strictEqual(read(claude), '# Lo personal de Claude\nTEXTO-SÓLO-DE-CLAUDE\n@~/algo/README.md\n', 'CLAUDE.md no se toca');
});

test('un espejo viejo (copia del CLAUDE.md, marcas de antes): los bloques se actualizan EN SU LUGAR, sin duplicarse, y lo demás queda', () => {
  const l = lab();
  fs.mkdirSync(path.dirname(l.target), { recursive: true });
  const old = [
    '# Global Claude Code Instructions', 'lo personal que venía copiado', '@~/.claude/algo/README.md', '',
    // (el texto de la marca de antes no importa: el bloque se ubica por su prefijo)
    '<!-- TYCON_BLOCK:style START — generado por el sincronizador de antes · NO EDITAR A MANO -->',
    'cuerpo VIEJO del estilo', '<!-- TYCON_BLOCK:style END -->', '', 'más texto personal', '',
  ].join('\n');
  fs.writeFileSync(l.target, old);
  run(l);
  const t = read(l.target);
  assert.strictEqual(t.split(startOf('style')).length - 1, 1, 'el bloque no se duplica');
  assert.match(between(t, 'style'), /regla de estilo/);
  assert.doesNotMatch(t, /cuerpo VIEJO/);
  assert.ok(t.includes('lo personal que venía copiado\n@~/.claude/algo/README.md\n'), 'lo que ya estaba fuera de las marcas no se toca (tampoco su @import viejo: es de la persona)');
  assert.ok(t.indexOf('más texto personal') > t.indexOf(endOf('style')), 'y sigue en su lugar');
});

test('idempotente: la segunda ejecución no escribe', () => {
  const l = lab();
  run(l);
  const stat = fs.statSync(l.target);
  const text = read(l.target);
  const r = run(l);
  assert.strictEqual(r.changed, false);
  assert.strictEqual(read(l.target), text);
  assert.strictEqual(fs.statSync(l.target).mtimeMs, stat.mtimeMs);
  assert.deepStrictEqual(fs.readdirSync(path.dirname(l.target)), ['AGENTS.md'], 'sin copias ni temporales alrededor');
});

test('--check no escribe y dice qué está desactualizado', () => {
  const l = lab();
  const r = run(l, { check: true });
  assert.strictEqual(fs.existsSync(l.target), false, '--check no crea el archivo');
  assert.strictEqual(r.pending, true);
  run(l);
  const text = read(l.target);
  fs.writeFileSync(path.join(l.blocks, 'style.md'), '# Estilo\notra regla\n');
  const c = run(l, { check: true });
  assert.strictEqual(c.pending, true);
  assert.ok(c.lines.some((x) => /style/.test(x) && /desactualizado/.test(x)), c.lines.join('|'));
  assert.strictEqual(read(l.target), text);
  fs.writeFileSync(path.join(l.blocks, 'style.md'), '# Estilo\nregla de estilo\n');
  assert.strictEqual(run(l, { check: true }).pending, false, 'al día: nada pendiente');
});

test('integración apagada o perfil que no lo trae: el bloque no se agrega, y si estaba se quita entre sus marcas', () => {
  const l = lab();
  run(l, { integrations: { clockify: false }, profile: 'minimal' });
  let t = read(l.target);
  assert.ok(!t.includes(startOf('clock')), 'integración apagada: no se agrega');
  assert.ok(!t.includes(startOf('brakes')), 'perfil minimal: el bloque de full no se agrega');
  assert.ok(t.includes(startOf('style')));
  run(l);   // se prenden: aparecen
  t = read(l.target);
  assert.ok(t.includes(startOf('clock')) && t.includes(startOf('brakes')));
  const withBoth = t;
  run(l, { integrations: { clockify: false }, profile: 'minimal' });   // se apagan: se van, y lo demás queda igual
  t = read(l.target);
  assert.ok(!t.includes(startOf('clock')) && !t.includes(startOf('brakes')) && !/regla del reloj|regla de los frenos/.test(t));
  assert.ok(t.includes(startOf('style')) && t.includes(startOf('tool-names')));
  assert.ok(withBoth.length > t.length);
});

test('«no se pudo saber» no es «apagada»: lo que falta no se agrega, lo que está queda y se actualiza, y se dice', () => {
  const l = lab();
  const r = run(l, { integrations: null, integrationsWhy: 'configuración rota' });
  let t = read(l.target);
  assert.ok(!t.includes(startOf('clock')), 'sin saber: no se agrega');
  assert.ok(r.lines.some((x) => /clock/.test(x) && /no pude saber/.test(x)), r.lines.join('|'));
  run(l);   // ahora sí
  fs.writeFileSync(path.join(l.blocks, 'clock.md'), '<!-- requires-integration: clockify -->\n# Reloj\nregla del reloj v2\n');
  run(l, { integrations: null, integrationsWhy: 'configuración rota' });
  t = read(l.target);
  assert.match(between(t, 'clock'), /regla del reloj v2/, 'sin saber, lo que está queda y se actualiza');
});

test('una marca de cierre perdida no se adivina: ese bloque no se toca y se avisa; los demás sí', () => {
  const l = lab();
  run(l);
  const t = read(l.target).replace(endOf('style'), '(cierre borrado a mano)');
  fs.writeFileSync(l.target, t);
  fs.writeFileSync(path.join(l.blocks, 'style.md'), '# Estilo\notra\n');
  fs.writeFileSync(path.join(l.blocks, 'brakes.md'), '<!-- requires-profile: full -->\n# Frenos\nfrenos v2\n');
  const r = run(l);
  const after = read(l.target);
  assert.ok(r.lines.some((x) => /style/.test(x) && /cierre/i.test(x)), r.lines.join('|'));
  assert.match(after, /regla de estilo/, 'el bloque roto queda como estaba');
  assert.match(between(after, 'brakes'), /frenos v2/);
});

test('anota su pieza para el registro y para el plan, con la forma del aplicador', () => {
  const l = lab();
  const report = path.join(l.dir, 'report.tsv');
  const planFile = path.join(l.dir, 'plan.tsv');
  const c = run(l, { check: true, planFile });
  assert.strictEqual(c.pending, true);
  assert.strictEqual(read(planFile), `codex\t${l.target}\tAGENTS.md\tadd\n`);
  run(l, { reportFile: report });
  assert.strictEqual(read(report), `codex\t${l.target}\tAGENTS.md\n`);
  fs.rmSync(planFile);
  run(l, { check: true, planFile });
  assert.strictEqual(read(planFile), `codex\t${l.target}\tAGENTS.md\tkeep\n`);
});

test('con los bloques de verdad del arnés: todos entre marcas y la variante de Codex en su lugar', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-md-real-'));
  const target = path.join(dir, 'AGENTS.md');
  const blocks = path.join(ROOT, 'claude-md-blocks');
  const r = A().sync({ blocksDir: blocks, target, integrations: { ado: true, clockify: true, engram: true, codegraph: true, mailbox: true, codex: true, nightly: true, telegram: true }, profile: 'full', response: { language: 'es', style: 'executive', max_chars: 1300 }, quiet: true });
  assert.strictEqual(r.ok, true);
  const t = read(target);
  // los bloques de un archivo y los de una carpeta de variantes (response-style)
  const names = [...fs.readdirSync(blocks).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)), 'response-style'];
  assert.ok(names.length >= 3);
  for (const n of names) assert.ok(t.includes(startOf(n)) && t.includes(endOf(n)), `falta ${n}`);
  for (const v of fs.readdirSync(path.join(blocks, 'names')).filter((f) => f.endsWith('.codex.md'))) {
    // con todas las integraciones prendidas, cada fila sin su marca de integración
    // (sin decir la herramienta de horas, el lugar de sus filas no deja ninguna: el destino estaba vacío)
    const body = read(path.join(blocks, 'names', v)).replace(/^\n+|\n+$/g, '').replace(/[ \t]*<!--\s*integration:\s*[a-z]+\s*-->/g, '').replace(/^<!--\s*time-tool-rows\s*-->\n/m, '');
    assert.strictEqual(between(t, v.replace(/\.codex\.md$/, '')).replace(/\n$/, ''), body, `la variante ${v} es el cuerpo del bloque`);
  }
  assert.ok(!t.split('\n').some((line) => line.startsWith('@')), 'ningún @import');
});
