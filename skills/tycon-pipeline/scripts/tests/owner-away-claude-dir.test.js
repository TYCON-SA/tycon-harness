'use strict';
/**
 * owner-away-claude-dir.test.js — con el dueño ausente, no se edita a mano la carpeta de Claude Code: Claude Code pide una
 * confirmación que nadie da, y la sesión queda esperando. Todo con una casa de juguete: nada lee la casa real.
 * stable-data: las horas salen de la marca recién puesta; ninguna prueba depende del día.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RAIZ = path.join(__dirname, '..', '..', '..', '..');
const C = require(path.join(__dirname, '..', 'on-owner-away-claude-dir.js'));
const MA = require(path.join(RAIZ, 'scripts', 'lib', 'owner-away.js'));
const { stateDir } = require(path.join(__dirname, '..', 'lib', 'state-dir.js'));

function casa(t) {
  const raiz = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'away-claude-')));
  t.after(() => fs.rmSync(raiz, { recursive: true, force: true }));
  const home = path.join(raiz, 'casa');
  fs.mkdirSync(path.join(home, '.claude', 'skills', 'x'), { recursive: true });
  fs.mkdirSync(path.join(raiz, 'repo'), { recursive: true });
  return { raiz, home };
}
const edicion = (file) => ({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: file }, cwd: '/r' });

test('T1 DuenoAusente_EditarLaCarpetaDeClaude_Frena — sin marca, fuera de la carpeta, jobs/ y projects/ pasan', (t) => {
  // 🔴 mutación: que handle devuelva null siempre (entonces la edición con la marca puesta pasa y esto falla).
  const { raiz, home } = casa(t);
  const ajustes = path.join(home, '.claude', 'settings.json');
  const skill = path.join(home, '.claude', 'skills', 'x', 'SKILL.md');
  const h = (file) => C.handle(edicion(file), { home });
  assert.strictEqual(h(ajustes), null, 'sin marca, pasa');
  assert.strictEqual(MA.set({ home, quien: 'coord', frase: 'hasta mañana' }).codigo, 0);
  for (const f of [ajustes, skill]) {
    const r = h(f);
    assert.ok(r && r.block, f);
    assert.match(r.block, /dueño está ausente[\s\S]*carpeta de Claude Code[\s\S]*guion del arnés[\s\S]*cuando vuelva/);
  }
  assert.strictEqual(h(path.join(raiz, 'repo', 'a.js')), null, 'un archivo de un repo no es de esta regla');
  assert.strictEqual(h(path.join(home, '.claude', 'jobs', 'abc', 'tmp', 'nota.md')), null, 'la carpeta de trabajo de la sesión es libre');
  assert.strictEqual(h(path.join(home, '.claude', 'projects', 'p', 'memory', 'm.md')), null, 'las memorias son libres');
  assert.strictEqual(h(path.join(home, '.claude-otra', 'x.json')), null, 'una carpeta con el nombre parecido no es la de Claude');
  // el dueño volvió
  MA.clear({ home, motivo: 'volvió' });
  assert.strictEqual(h(ajustes), null);
});

test('T2 MarcaIlegible_ElDuenoCuentaComoPresente_Pasa · interruptor apagado pasa', (t) => {
  // 🔴 mutación: tratar una marca que no se puede leer como puesta (frenaría a una persona que está ahí).
  const { home } = casa(t);
  const ajustes = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(stateDir(home), { recursive: true });
  fs.writeFileSync(path.join(stateDir(home), MA.ARCHIVO), '{ roto');
  assert.strictEqual(C.handle(edicion(ajustes), { home }), null);
  fs.rmSync(path.join(stateDir(home), MA.ARCHIVO));
  MA.set({ home, quien: 'coord', frase: 'me voy' });
  const antes = process.env.TYCON_OWNER_AWAY_CLAUDE_DIR_GUARD;
  process.env.TYCON_OWNER_AWAY_CLAUDE_DIR_GUARD = '0';
  t.after(() => { if (antes === undefined) delete process.env.TYCON_OWNER_AWAY_CLAUDE_DIR_GUARD; else process.env.TYCON_OWNER_AWAY_CLAUDE_DIR_GUARD = antes; });
  assert.strictEqual(C.handle(edicion(ajustes), { home }), null);
});

test('T3 CarpetaConOtraCaja_Y_CarpetasNuevas — en macOS y Windows ~/.Claude es la misma; dos niveles que no existen se resuelven bien', (t) => {
  // 🔴 mutación: comparar con la caja de las letras (en macOS `~/.Claude/settings.json` pasa), o resolver mal las carpetas
  // que todavía no existen.
  const { home } = casa(t);
  MA.set({ home, quien: 'coord', frase: 'me voy' });
  assert.ok(C.handle(edicion(path.join(home, '.claude', 'nuevo', 'dir', 'f.md')), { home }), 'dos carpetas nuevas adentro');
  assert.strictEqual(C.handle(edicion(path.join(home, '.claude', 'jobs', 'nuevo', 'dir', 'f.md')), { home }), null, 'y dentro de jobs/ pasa');
  if (process.platform === 'darwin' || process.platform === 'win32') {
    assert.ok(C.handle(edicion(path.join(home, '.Claude', 'settings.json')), { home }), 'otra caja, la misma carpeta');
  }
});
