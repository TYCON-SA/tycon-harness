#!/usr/bin/env node
/**
 * scripts/lib/hook-io.js — la ÚNICA función de normalización de eventos de hook que la
 * migración terminó necesitando (Etapa E2, 2026-08-22).
 *
 * El plan presupuestaba una "capa de normalización" entera; B1 midió que el payload de Codex
 * usa los mismos nombres de campo que Claude y la capa murió (Registro E1). Lo único que SÍ
 * difiere es la tool de edición: Claude emite Edit/Write con {file_path, ...}; Codex emite
 * `apply_patch` con tool_input.command = TEXTO de patch (sonda E2, payload real; resumido en
 * guides/codex-migration.md, Registro E2):
 *
 *   *** Begin Patch
 *   *** Update File: /ruta/abs/notas.txt
 *   @@
 *   -hola foo mundo
 *   +hola bar mundo
 *   *** End Patch
 *
 * `editEventsFrom(event)` devuelve SIEMPRE una lista de eventos claude-shaped:
 *   - evento Edit/Write (o cualquier otro) → [event] tal cual (identidad — el lado Claude no
 *     cambia ni un byte de comportamiento);
 *   - evento apply_patch → un evento POR ARCHIVO del patch, con tool_name mapeado
 *     (Add File → Write · Update/Delete File → Edit), tool_input.file_path seteado, y el
 *     original preservado en tool_name_raw. Un patch multi-archivo produce N eventos: el
 *     consumidor decide si corre su lógica por cada uno (dispatch.js lo hace).
 *
 * Consumidores (los 3 registros con matcher de edición + quien lo necesite):
 *   - agent-skills/skills/tycon-pipeline/scripts/dispatch.js (pre-edit y post-edit)
 *   - ~/.claude/tycon-harness/scripts/hooks/rebuild-before-verify.js (marca PostToolUse)
 * Todos lo requieren vía TYCON_GUIDES_DIR (default ~/.claude/tycon-harness) CON
 * FALLBACK a la conducta actual si la lib no está: eso hace el rollout cross-repo seguro por
 * orden (agent-skills main se propaga antes de que este branch mergee — sin la lib, nada cambia).
 *
 * Uso directo: node hook-io.js --selftest
 */
'use strict';

const path = require('path');

// Versión por-línea (sin /g) primero: es LA definición del header; la global se deriva de su
// source para que patchFiles y addFileContent no puedan divergir (si el formato suma un verbo,
// se toca UN solo patrón — dos copias del mismo regex son el drift de mañana).
const PATCH_FILE_LINE_RE = /^\*\*\* (Add|Update|Delete) File: (.+)$/;
const PATCH_FILE_RE = new RegExp(PATCH_FILE_LINE_RE.source, 'gm');

/** texto de patch → [{op, path}] */
function patchFiles(text) {
  const out = [];
  let m;
  PATCH_FILE_RE.lastIndex = 0;
  while ((m = PATCH_FILE_RE.exec(String(text || '')))) out.push({ op: m[1], path: m[2].trim() });
  return out;
}

// Los paths de un patch de Codex vienen RELATIVOS al cwd de la sesión — así los escribe el
// modelo (`*** Add File: src/slugify.js`) y así llegan al hook. Toda la cadena que consume estos
// eventos trabaja en absoluto: `on-edit.js` arranca con `if (!path.isAbsolute(filePath)) return
// null`, o sea que un path relativo se descarta EN SILENCIO y la edición no queda registrada en
// ningún lado. Resolverlo acá —donde ya vive el único traductor— arregla a todos los consumidores
// de una vez, en vez de repetir el `resolve` en cada hoja de la cadena.
//
// Caso real (pasada 2 de la corrida dorada, 2026-08-22): con paths relativos, `file-events/<sid>`
// y `marker.fileEvents` quedaron vacíos y el gate de ATDD salió `warn-unknown` — ciego, aunque el
// ATDD se había hecho bien. Lo que lo mantuvo invisible hasta acá: el patch que capturó la sonda
// E2, del que salieron los casos del banco, traía el path ABSOLUTO. El caso de prueba usaba una
// forma que el sistema real no produce, y por eso pasaba en verde.
function resolvePatchPath(p, cwd) {
  if (!p) return p;
  if (path.isAbsolute(p)) return p;
  // Sin cwd en el payload no hay contra qué resolver: se devuelve tal cual (conducta previa) en
  // vez de inventar una raíz — un path mal resuelto registraría ediciones de archivos que no son.
  return cwd ? path.resolve(String(cwd), p) : p;
}

// Un `Write` claude-shaped lleva `tool_input.content` — y varios consumidores deciden POR ese
// content (los hooks de story-create leen el frontmatter; on-frontmatter-write toma el content
// como estado final). Hasta 2026-08-28 los eventos Add File salían SIN content: cada consumidor
// content-based quedaba MUDO bajo Codex, sin error — el mismo silencio del caso
// incident-log#story-write-spawn-2026-08-28. En el formato apply_patch el cuerpo de un Add File
// son sus líneas '+' (sin prefijo); si aparece una línea que no se puede atribuir con certeza,
// se devuelve null y NO se inventa contenido (peor un consumidor mudo que uno decidiendo sobre
// un content reconstruido mal).
function addFileContent(patchText, rawPath) {
  const lines = String(patchText || '').split('\n');
  let inSection = false;
  let found = false;
  const body = [];
  for (const line of lines) {
    const m = PATCH_FILE_LINE_RE.exec(line);
    if (m) {
      if (inSection) break; // arrancó la sección siguiente
      inSection = m[1] === 'Add' && m[2].trim() === rawPath;
      if (inSection) found = true;
      continue;
    }
    if (line.startsWith('*** ')) { if (inSection) break; continue; } // End Patch / Begin Patch
    if (!inSection) continue;
    if (line.startsWith('+')) body.push(line.slice(1));
    // Una línea en blanco del archivo viaja como '+' solo; una línea en blanco CRUDA es formato
    // que este parser no atribuye — igual que cualquier otra línea sin '+': null, no se inventa
    // (la 1ra versión la convertía en línea vacía del archivo — contenido que el patch no dice).
    else return null;
  }
  return found ? body.join('\n') : null;
}

/** evento de hook → lista de eventos claude-shaped (identidad salvo apply_patch) */
function editEventsFrom(event) {
  if (!event || event.tool_name !== 'apply_patch') return [event];
  const ti = event.tool_input || {};
  const patchText = ti.command || ti.patch || ti.input || '';
  const files = patchFiles(patchText);
  if (!files.length) return [event]; // patch ilegible → identidad (fail-open; el matcher ya disparó)
  return files.map((f) => {
    const ti2 = Object.assign({}, ti, { file_path: resolvePatchPath(f.path, event.cwd) });
    if (f.op === 'Add' && ti2.content === undefined) {
      const body = addFileContent(patchText, f.path);
      if (body !== null) ti2.content = body;
    }
    return Object.assign({}, event, {
      tool_name: f.op === 'Add' ? 'Write' : 'Edit',
      tool_name_raw: 'apply_patch',
      tool_input: ti2,
    });
  });
}

function selftest() {
  // patch REAL capturado por la sonda E2 (2026-08-22) — no fabricado
  const real = '*** Begin Patch\n*** Update File: /tmp/fx/notas.txt\n@@\n-hola foo mundo\n+hola bar mundo\n*** End Patch';
  const evEdit = { tool_name: 'Edit', tool_input: { file_path: '/a.ts', old_string: 'x', new_string: 'y' } };
  const evPatch = { hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command: real } };
  const multi = '*** Begin Patch\n*** Add File: /fx/nuevo.ts\n+x\n*** Update File: /fx/viejo.ts\n@@\n-a\n+b\n*** Delete File: /fx/muerto.ts\n*** End Patch';
  const evMulti = { tool_name: 'apply_patch', tool_input: { command: multi } };
  const r1 = editEventsFrom(evEdit);
  const r2 = editEventsFrom(evPatch);
  const r3 = editEventsFrom(evMulti);
  const checks = [
    ['Edit claude → identidad (mismo objeto, sin tocar)', r1.length === 1 && r1[0] === evEdit],
    ['apply_patch real → 1 evento Edit con file_path', r2.length === 1 && r2[0].tool_name === 'Edit' && r2[0].tool_input.file_path === '/tmp/fx/notas.txt'],
    ['el original queda en tool_name_raw', r2[0].tool_name_raw === 'apply_patch'],
    ['los campos comunes del payload se preservan', r2[0].hook_event_name === 'PreToolUse'],
    ['multi-archivo → 3 eventos, Add mapea a Write', r3.length === 3 && r3[0].tool_name === 'Write' && r3[0].tool_input.file_path === '/fx/nuevo.ts'],
    ['Update y Delete mapean a Edit', r3[1].tool_name === 'Edit' && r3[2].tool_name === 'Edit'],
    // ── content en los Add File (caso story-write-spawn, 2026-08-28) ───────────────────────
    // Un Write sin content deja mudo a todo consumidor content-based (hooks de story-create,
    // on-frontmatter-write). El cuerpo del Add son sus líneas '+', sin el prefijo.
    ['Add File → el Write lleva content (las líneas + sin prefijo)', r3[0].tool_input.content === 'x'],
    ['Update File → sin content (no se puede reconstruir el estado final)', r3[1].tool_input.content === undefined],
    ...(() => {
      const story = '*** Begin Patch\n*** Add File: docs/epic-x/story-9-9.md\n+---\n+story: "9.9"\n+status: backlog\n+---\n+cuerpo\n*** End Patch';
      const ev = editEventsFrom({ cwd: '/fx/repo', tool_name: 'apply_patch', tool_input: { command: story } })[0];
      const raro = '*** Begin Patch\n*** Add File: /fx/a.md\n+ok\nlinea-sin-prefijo\n*** End Patch';
      const evRaro = editEventsFrom({ tool_name: 'apply_patch', tool_input: { command: raro } })[0];
      // Hallazgo del review 2026-08-28: un blanco CRUDO dentro del Add se convertía en línea
      // vacía del archivo — contenido que el patch no atribuye. La línea vacía real viaja '+'.
      const blanco = '*** Begin Patch\n*** Add File: /fx/b.md\n+x\n\n*** End Patch';
      const evBlanco = editEventsFrom({ tool_name: 'apply_patch', tool_input: { command: blanco } })[0];
      const vaciaReal = '*** Begin Patch\n*** Add File: /fx/c.md\n+x\n+\n+y\n*** End Patch';
      const evVacia = editEventsFrom({ tool_name: 'apply_patch', tool_input: { command: vaciaReal } })[0];
      return [
        ['Add multilínea → content completo, con su frontmatter legible', ev.tool_input.content === '---\nstory: "9.9"\nstatus: backlog\n---\ncuerpo'],
        ['Add con línea no atribuible → SIN content (no se inventa)', evRaro.tool_input.content === undefined],
        ['Add con blanco CRUDO → SIN content (un blanco sin + no es del archivo)', evBlanco.tool_input.content === undefined],
        ["Add con '+' solo → línea vacía REAL del archivo", evVacia.tool_input.content === 'x\n\ny'],
      ];
    })(),
    ['patch ilegible → identidad, no crash', editEventsFrom({ tool_name: 'apply_patch', tool_input: { command: 'basura' } }).length === 1],
    ['evento null → [null] sin crash', editEventsFrom(null).length === 1],
    // ── paths relativos (pasada 2 de la corrida dorada, 2026-08-22) ────────────────────────
    // Patch REAL de esa corrida: Codex escribe los paths relativos al cwd. Sin resolverlos, la
    // cadena entera los descarta en silencio (`on-edit.js` exige absoluto) y la edición no queda
    // registrada en ningún lado — el gate de ATDD se queda ciego sin que nada se ponga rojo.
    ...(() => {
      const rel = '*** Begin Patch\n*** Add File: test/slugify.test.js\n+const t = 1;\n*** End Patch';
      const conCwd = editEventsFrom({ cwd: '/fx/repo', tool_name: 'apply_patch', tool_input: { command: rel } });
      const sinCwd = editEventsFrom({ tool_name: 'apply_patch', tool_input: { command: rel } });
      const abs = editEventsFrom({ cwd: '/otro/lado', tool_name: 'apply_patch', tool_input: { command: real } });
      const subeNivel = editEventsFrom({ cwd: '/fx/repo/sub', tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: ../src/a.js\n@@\n-a\n+b\n*** End Patch' } });
      return [
        ['path relativo + cwd → absoluto contra el cwd', conCwd[0].tool_input.file_path === path.join('/fx/repo', 'test/slugify.test.js')],
        ['sin cwd → se devuelve tal cual (no se inventa raíz)', sinCwd[0].tool_input.file_path === 'test/slugify.test.js'],
        ['path ya absoluto → intacto, el cwd no lo toca', abs[0].tool_input.file_path === '/tmp/fx/notas.txt'],
        ['los ".." se normalizan al resolver', subeNivel[0].tool_input.file_path === path.join('/fx/repo', 'src/a.js')],
      ];
    })(),
  ];
  let bad = 0;
  for (const [name, ok] of checks) { console.log(`${ok ? '✅' : '❌'} selftest-hook-io: ${name}`); if (!ok) bad++; }
  console.log(bad ? `❌ ${bad} rojos` : `✅ selftest-hook-io: ${checks.length}/${checks.length} verdes`);
  return bad ? 1 : 0;
}

module.exports = { patchFiles, editEventsFrom };

if (require.main === module && process.argv.includes('--selftest')) process.exit(selftest());
