#!/usr/bin/env bash
# canonical-path.test.sh — el aviso de "el arnés no está donde el arnés cree que está" (2026-09-05).
#
# Caso: un dev con el clon fuera de ~/SourceCode/tycon-claude-guides no veía ningún error, y 15
# revisores buscaban las guías en una ruta que en su máquina no existía: leían menos, callados.
# El clon lo pone una persona a mano una sola vez; lo que se instala solo viene después. Nadie
# miraba ese paso. Detalle: scripts/lib/canonical-path.js.
#
# 🔴 Sin pipes sobre el comando: el exit code REAL es el veredicto (regla 5 de
# test-execution-discipline — un `| tail` enmascara el rojo).
set -u
TCG="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
J="$TCG/scripts/lib/canonical-path.js"
node "$J" --selftest || exit 1

# Caja negra: desde otra carpeta HABLA; desde la canónica CALLA; y sale 0 en los dos (aviso, no freno).
T="$(mktemp -d)"; mkdir -p "$T/a" "$T/b"
out="$(TYCON_GUIDES_DIR= TYCON_NO_CANONICAL_PATH= node "$J" --clone "$T/b" --canonical "$T/a")"; rc=$?
[ "$rc" -eq 0 ] && [ -n "$out" ] || { echo "❌ clon en otra carpeta: esperaba aviso y exit 0 (rc=$rc, out='$out')"; exit 1; }
out="$(TYCON_GUIDES_DIR= TYCON_NO_CANONICAL_PATH= node "$J" --clone "$T/a" --canonical "$T/a")"; rc=$?
[ "$rc" -eq 0 ] && [ -z "$out" ] || { echo "❌ clon canónico: esperaba silencio y exit 0 (rc=$rc, out='$out')"; exit 1; }

# Caja negra de los enlaces del repo único (story 8.7, pase adversarial de la tanda C): una entrada del clon que es
# ella misma un enlace colgado no se enlaza, y la segunda corrida no dice nada (antes se agregaba y se sacaba en cada
# corrida). El espejo: la entrada sana sí queda enlazada.
mkdir -p "$T/single/scripts" "$T/single/skills/tycon-pipeline" "$T/single/agents" "$T/home/.claude/skills" "$T/home/.claude/agents"
: > "$T/single/scripts/install-tycon-hooks.sh"; ln -s "$T/no-such/zzz" "$T/single/skills/dangling"
out="$(TYCON_REPORT_PIECES= node "$J" --ensure-repo-links --clone "$T/single" --home "$T/home" --only entries)"; rc=$?
[ "$rc" -eq 0 ] && [ -L "$T/home/.claude/skills/tycon-pipeline" ] && [ ! -L "$T/home/.claude/skills/dangling" ] \
  || { echo "❌ repo único, entrada colgada: esperaba la sana enlazada y la colgada sin enlazar (rc=$rc, out='$out')"; exit 1; }
out="$(TYCON_REPORT_PIECES= node "$J" --ensure-repo-links --clone "$T/single" --home "$T/home" --only entries)"; rc=$?
[ "$rc" -eq 0 ] && [ -z "$out" ] || { echo "❌ repo único, segunda corrida: esperaba silencio y exit 0 (rc=$rc, out='$out')"; exit 1; }

# T51 · Links_AgentsRealFolder_FileLinkThenHardLinkThenSaysSo (story 8.17, W4 · AC 39; decisión C18 de la 8.7)
# Con ~/.claude/agents como carpeta real, cada revisor (un archivo) se enlaza probando primero el enlace de archivo; si
# Windows lo niega (sin «modo desarrollador»), un enlace duro; si tampoco, lo dice y no escribe. Una carpeta va siempre
# con junction en Windows. El creador de enlaces se inyecta: en esta máquina el enlace de archivo no falla nunca.
# 🔴 rojo previo: linkEntries llamaba a fs.symlinkSync directo y, si fallaba, no probaba el enlace duro.
node - "$J" "$T/t51" <<'JS'
'use strict';
const fs = require('fs'); const path = require('path');
const [J, base] = process.argv.slice(2);
const { ensureRepoLinks } = require(J);
const mk = (...p) => { const d = path.join(base, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
const clone = mk('clone'); mk('clone', 'scripts'); fs.writeFileSync(path.join(clone, 'scripts', 'install-tycon-hooks.sh'), '');
mk('clone', 'skills', 'tycon-pipeline'); mk('clone', 'agents');
fs.writeFileSync(path.join(clone, 'agents', 'rev-a.md'), '# a\n');
const home = (n) => { const h = mk('homes', n); mk('homes', n, '.claude', 'agents'); mk('homes', n, '.claude', 'skills'); return h; };
const denied = () => { const e = new Error('operation not permitted'); e.code = 'EPERM'; throw e; };
const fails = [];
const check = (name, cond, extra) => { if (!cond) fails.push(`${name}${extra ? ` — ${extra}` : ''}`); };
const calls = [];
const spy = (impl) => ({ symlink: (t, w, type) => { calls.push(['symlink', type, path.basename(w)]); return impl.symlink(t, w, type); },
  link: (t, w) => { calls.push(['link', path.basename(w)]); return impl.link(t, w); }, platform: impl.platform });

// 1 · Windows niega el enlace de archivo: queda el enlace duro (mismo archivo), y la carpeta va con junction
let h = home('hard'); calls.length = 0;
let r = ensureRepoLinks({ clone, home: h, only: 'entries', links: spy({ symlink: (t, w, type) => (type === 'file' ? denied() : fs.symlinkSync(t, w, 'dir')), link: fs.linkSync, platform: 'win32' }) });
const where = path.join(h, '.claude', 'agents', 'rev-a.md');
const st = (() => { try { return fs.lstatSync(where); } catch (_) { return null; } })();
const src = fs.statSync(path.join(clone, 'agents', 'rev-a.md'));
check('el de archivo se prueba primero', JSON.stringify(calls.filter((c) => c[2] === 'rev-a.md' || c[1] === 'rev-a.md').slice(0, 2)) === JSON.stringify([['symlink', 'file', 'rev-a.md'], ['link', 'rev-a.md']]), JSON.stringify(calls));
check('queda el enlace duro', st && !st.isSymbolicLink() && st.ino === src.ino && st.dev === src.dev, JSON.stringify(st && { ino: st.ino, sym: st.isSymbolicLink() }));
check('una carpeta va con junction en Windows', calls.some((c) => c[0] === 'symlink' && c[1] === 'junction' && c[2] === 'tycon-pipeline'), JSON.stringify(calls));
check('el duro es pieza', r.pieces.some((p) => p.id === 'agents/rev-a.md'), JSON.stringify(r.pieces));
check('lo dice: enlace duro', r.lines.some((l) => /enlace\(s\) duro\(s\)/.test(l) && /modo desarrollador/.test(l)), JSON.stringify(r.lines));
// la segunda corrida reconoce su enlace duro: ni «choca» ni lo vuelve a crear
calls.length = 0;
r = ensureRepoLinks({ clone, home: h, only: 'entries', links: spy({ symlink: denied, link: fs.linkSync, platform: 'win32' }) });
check('segunda corrida: el duro está en su lugar, sin líneas ni llamadas', r.lines.length === 0 && calls.length === 0 && r.pieces.some((p) => p.id === 'agents/rev-a.md'), `${JSON.stringify(r.lines)} ${JSON.stringify(calls)}`);

// 2 · fallan los dos: «no pude enlazar», sin escribir
h = home('none');
r = ensureRepoLinks({ clone, home: h, only: 'entries', links: { symlink: (t, w, type) => (type === 'file' ? denied() : fs.symlinkSync(t, w, 'dir')), link: denied, platform: 'win32' } });
check('fallan los dos: no escribió el revisor', !fs.existsSync(path.join(h, '.claude', 'agents', 'rev-a.md')) && fs.readdirSync(path.join(h, '.claude', 'agents')).length === 0);
check('fallan los dos: «no pude enlazar» con el nombre', r.lines.some((l) => /no pude enlazar/.test(l) && /agents\/rev-a\.md/.test(l)), JSON.stringify(r.lines));
check('fallan los dos: no es pieza', !r.pieces.some((p) => p.id === 'agents/rev-a.md'));

// 3 · el espejo: con el enlace de archivo permitido, es un enlace de archivo (el duro no se prueba)
h = home('sym'); calls.length = 0;
r = ensureRepoLinks({ clone, home: h, only: 'entries', links: spy({ symlink: fs.symlinkSync, link: fs.linkSync, platform: process.platform }) });
check('con permiso: enlace de archivo, sin probar el duro', fs.lstatSync(path.join(h, '.claude', 'agents', 'rev-a.md')).isSymbolicLink() && !calls.some((c) => c[0] === 'link'), JSON.stringify(calls));

if (fails.length) { console.log(`❌ T51 enlaces de los revisores: ${fails.join(' · ')}`); process.exit(1); }
console.log('✅ T51 revisores en una carpeta real: enlace de archivo → enlace duro → «no pude enlazar» sin escribir; carpetas con junction');
JS
[ $? -eq 0 ] || exit 1

# T51b · Links_HardLinkOrphan_SweptAndUninstallable (story 8.17, W4 · pase adversarial, clases 2, 3, 9 y 14)
# Un enlace duro es un archivo común: no queda «colgado» cuando el revisor se borra del clon. El arnés anota los que
# crea (~/.claude/.tycon-pipeline/hard-links.json) y la corrida siguiente saca ésos —y sólo ésos—; el desinstalador
# pregunta lo mismo (ownHardLink). Un archivo propio con el mismo nombre no se toca.
# 🔴 rojo previo (pruebas del pase: traversal-completeness-2, integration-contracts-5, false-positive-edge-4): el
#    revisor borrado del clon seguía en ~/.claude/agents, sin línea, y el desinstalador decía «no lo toco».
node - "$J" "$T/t51b" <<'JS'
'use strict';
const fs = require('fs'); const path = require('path');
const [J, base] = process.argv.slice(2);
const cp = require(J);
const { ensureRepoLinks } = cp;
const own = typeof cp.ownHardLink === 'function' ? cp.ownHardLink : () => 'sin ownHardLink';
const forget = typeof cp.forgetHardLink === 'function' ? cp.forgetHardLink : () => {};
const mk = (...p) => { const d = path.join(base, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
const clone = mk('clone'); mk('clone', 'scripts'); fs.writeFileSync(path.join(clone, 'scripts', 'install-tycon-hooks.sh'), '');
mk('clone', 'skills', 'tycon-pipeline'); mk('clone', 'agents');
for (const n of ['rev-a', 'rev-b', 'rev-d']) fs.writeFileSync(path.join(clone, 'agents', `${n}.md`), `# ${n}\n`);
const h = mk('home'); mk('home', '.claude', 'agents'); mk('home', '.claude', 'skills');
const ag = (n) => path.join(h, '.claude', 'agents', n);
fs.writeFileSync(ag('mine.md'), '# mío\n');          // de la persona, sin par en el clon
const denied = () => { const e = new Error('operation not permitted'); e.code = 'EPERM'; throw e; };
const links = { symlink: (t, w, type) => (type === 'file' ? denied() : fs.symlinkSync(t, w, 'dir')), link: fs.linkSync, platform: 'win32' };
const run = (o = {}) => ensureRepoLinks(Object.assign({ clone, home: h, only: 'entries', links }, o));
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; } };
const fails = [];
const check = (name, cond, extra) => { if (!cond) fails.push(`${name}${extra ? ` — ${extra}` : ''}`); };

let r = run();
check('los tres revisores quedan como enlace duro y anotados como del arnés',
  r.lines.some((l) => /3 como enlace\(s\) duro\(s\)/.test(l)) && ['rev-a.md', 'rev-b.md', 'rev-d.md'].every((n) => own({ where: ag(n), home: h }) === true),
  JSON.stringify(r.lines));
check('el archivo propio no es del arnés', own({ where: ag('mine.md'), home: h }) === false);

// 1 · el revisor se borra del clon: --check dice que lo sacaría y no lo saca
fs.unlinkSync(path.join(clone, 'agents', 'rev-a.md'));
r = run({ check: true });
check('--check: sacaría 1 y no lo saca', read(ag('rev-a.md')) === '# rev-a\n' && r.lines.some((l) => /sacaría 1/.test(l))
  && r.plan.some((p) => p.id === 'agents/rev-a.md' && p.action === 'remove'), JSON.stringify(r.lines));
// …la corrida de verdad lo saca, lo dice, y lo propio queda
r = run();
check('la corrida siguiente saca el duro huérfano', !fs.existsSync(ag('rev-a.md')) && r.lines.some((l) => /1 sacado/.test(l)), JSON.stringify(r.lines));
check('…ya no está anotado ni es pieza', own({ where: ag('rev-a.md'), home: h }) === false && !r.pieces.some((p) => p.id === 'agents/rev-a.md'));
check('…y el archivo propio sigue intacto', read(ag('mine.md')) === '# mío\n');

// 2 · (espejo) la persona reemplazó el duro por un archivo suyo con el mismo nombre, y el revisor se borra del clon
fs.unlinkSync(ag('rev-b.md')); fs.writeFileSync(ag('rev-b.md'), '# el rev-b de la persona\n');
fs.unlinkSync(path.join(clone, 'agents', 'rev-b.md'));
check('un archivo propio en el lugar del duro ya no es del arnés', own({ where: ag('rev-b.md'), home: h }) === false);
r = run();
check('…y la limpieza no lo toca', read(ag('rev-b.md')) === '# el rev-b de la persona\n', JSON.stringify(r.lines));

// 3 · el desinstalador: el duro del arnés sí (y sólo si cae bajo el árbol que se desinstala); lo propio no
check('ownHardLink: el duro vivo es del arnés, también con el árbol', own({ where: ag('rev-d.md'), home: h, tree: clone }) === true);
check('ownHardLink: con OTRO árbol, no', own({ where: ag('rev-d.md'), home: h, tree: path.join(base, 'otro') }) === false);
check('ownHardLink: lo propio, no', own({ where: ag('mine.md'), home: h, tree: clone }) === false);
check('ownHardLink: lo que no existe, no', own({ where: ag('no-hay.md'), home: h }) === false);

// 4 · git reemplaza el archivo del clon (un pull que lo cambia): el duro viejo es del arnés, se vuelve a enlazar
const fresh = path.join(clone, 'agents', 'rev-d.md.new'); fs.writeFileSync(fresh, '# rev-d v2\n'); fs.renameSync(fresh, path.join(clone, 'agents', 'rev-d.md'));
r = run();
const sd = fs.statSync(ag('rev-d.md'), { bigint: true }); const sc = fs.statSync(path.join(clone, 'agents', 'rev-d.md'), { bigint: true });
check('tras el pull: el duro se rehace (mismo archivo que el clon), sin línea de choque',
  sd.ino === sc.ino && sd.dev === sc.dev && read(ag('rev-d.md')) === '# rev-d v2\n' && !r.lines.some((l) => /no las piso/.test(l)), JSON.stringify(r.lines));

// 5 · forgetHardLink (lo llama el desinstalador al sacarlo): deja de estar anotado
forget({ where: ag('rev-d.md'), home: h });
check('forgetHardLink: ya no está anotado', own({ where: ag('rev-d.md'), home: h }) === false);

if (fails.length) { console.log(`❌ T51b enlaces duros del arnés: ${fails.join(' · ')}`); process.exit(1); }
console.log('✅ T51b enlaces duros: anotados, la corrida siguiente saca los huérfanos (sólo los suyos), el desinstalador los reconoce');
JS
[ $? -eq 0 ] || exit 1

# T51c · Links_SameFile_ComparesBigintIds (story 8.17, W4 · pase adversarial, clase 6; prueba false-negative-classification-5)
# En Windows el ID de archivo de NTFS pasa de 2^53: como Number, dos archivos distintos dan el mismo `ino`. Se simula
# así: lstat/stat SIN { bigint: true } devuelven el ID truncado (dos archivos distintos, mismo Number); con bigint, los
# de verdad. Esperado: el revisor PROPIO choca (no se toma por el enlace duro del clon) y no es pieza.
# 🔴 rojo previo: plan «keep» y pieza agents/revisor.md, sin línea de choque.
node - "$J" "$T/t51c" <<'JS'
'use strict';
const fs = require('fs'); const path = require('path');
const [J, base] = process.argv.slice(2);
const clone = path.join(base, 'clone'); const home = path.join(base, 'home');
fs.mkdirSync(path.join(clone, 'skills', 'tycon-pipeline'), { recursive: true }); fs.mkdirSync(path.join(clone, 'agents'), { recursive: true });
fs.mkdirSync(path.join(clone, 'scripts'), { recursive: true }); fs.writeFileSync(path.join(clone, 'scripts', 'install-tycon-hooks.sh'), '');
fs.writeFileSync(path.join(clone, 'agents', 'revisor.md'), 'del clon\n');
fs.mkdirSync(path.join(home, '.claude', 'agents'), { recursive: true }); fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
const mine = path.join(home, '.claude', 'agents', 'revisor.md'); fs.writeFileSync(mine, 'PROPIO de la persona\n');
const targetR = fs.realpathSync(path.join(clone, 'agents', 'revisor.md')); const mineR = fs.realpathSync(mine);
const idA = (40n << 48n) | 0x1A2B3Cn; const idB = idA + 1n;   // FileId de NTFS: secuencia<<48 | índice; contiguos
if (Number(idA) !== Number(idB)) { console.log('❌ T51c: la simulación no colisiona'); process.exit(1); }
const wrap = (orig) => function (p, o) {
  const s = orig.apply(fs, arguments); if (o && o.bigint) return s;
  let r; try { r = fs.realpathSync(p); } catch (_) { return s; }
  if (r === mineR) { s.ino = Number(idA); s.dev = 7; } else if (r === targetR) { s.ino = Number(idB); s.dev = 7; }
  return s;
};
fs.lstatSync = wrap(fs.lstatSync); fs.statSync = wrap(fs.statSync);
const { ensureRepoLinks } = require(J);
const fails = [];
for (const check of [true, false]) {
  const out = ensureRepoLinks({ clone, home, check, only: 'entries' });
  if (out.plan.some((x) => x.id === 'agents/revisor.md') || out.pieces.some((x) => x.id === 'agents/revisor.md')
    || !out.lines.some((l) => /no las piso/.test(l) && /agents\/revisor\.md/.test(l))) fails.push(`check=${check}: ${JSON.stringify({ plan: out.plan, lines: out.lines })}`);
}
if (fs.readFileSync(mine, 'utf8') !== 'PROPIO de la persona\n') fails.push('pisó el archivo propio');
if (fails.length) { console.log(`❌ T51c IDs de archivo de 64 bits: ${fails.join(' · ')}`); process.exit(1); }
console.log('✅ T51c sameFile compara IDs de 64 bits: un revisor propio con ID «igual como Number» choca y no se toma por el del clon');
JS
[ $? -eq 0 ] || exit 1
rm -rf "$T"
echo "✅ ruta-canonica: selftest + caja negra"
