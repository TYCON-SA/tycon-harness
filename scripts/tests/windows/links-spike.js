#!/usr/bin/env node
'use strict';
/**
 * links-spike.js — el sondeo de la story 8.33 (Task 1 · AC 1 · T1 `Spike_JunctionRetargetWhileHeld`): ¿se puede cambiar
 * la unión `~/.tycon/harness` de una versión a otra mientras la versión vieja está TOMADA en Windows?
 *
 * POR QUÉ EXISTE. La 8.23 cambia de versión renombrando carpetas, y en Windows el `rename` de una carpeta con un archivo
 * abierto, con un proceso parado adentro o con un vigilante de carpetas falla: con otra sesión o un VS Code abiertos la
 * actualización espera para siempre. La 8.33 hace que `~/.tycon/harness` sea una unión a `~/.tycon/versions/<v>` y que
 * actualizar sea cambiar la unión. Eso descansa en un hecho de Windows que sólo se sabe midiendo: que cambiar una unión
 * con su destino tomado anda. Este sondeo lo mide en cada corrida del escenario `no-clone`; si deja de andar, lo dice.
 *
 * QUÉ MIDE, en una carpeta del laboratorio (nunca en la carpeta del usuario del agente):
 *   (a) con la versión vieja tomada de tres formas —un archivo abierto sin compartir, un proceso con su carpeta de trabajo
 *       adentro, un `FileSystemWatcher` recursivo— y de las tres juntas, abiertas POR LA UNIÓN como lo haría una sesión:
 *         · cambiar la unión borrándola y renombrando una temporal (`remove`), y apartándola y renombrando la temporal
 *           (`aside`); después, que la unión lleve a la versión nueva y que el que tomaba siga vivo;
 *         · `Move-Item` de PowerShell sobre la unión (lo que hace el respaldo .ps1 de una copia fija vieja);
 *         · renombrar la carpeta vieja (lo que usa la limpieza para saber si está libre).
 *       Y sobre una copia con un archivo tomado, qué deja un borrado recursivo (si borra a medias).
 *   (b) una unión que apunta a otra unión (`~/.claude/tycon-harness` → `~/.tycon/harness` → `versions/<v>`): se lee bien
 *       antes y después del cambio.
 *   (c) qué devuelven `__dirname`, `realpath` y `require.main.filename` de Node, y `$PSScriptRoot` de PowerShell 7 y 5.1,
 *       al correr un guion por la unión y por la cadena.
 * Fuera de Windows corre igual con enlaces simbólicos, en «modo de laboratorio»: ahí nada se traba, así que (a) no dice nada.
 *
 * Lo llama no-clone-probe.js como su primer paso. Deja los datos en `rec.fact('links_spike', …)` y un hallazgo
 * `no-clone:links-retarget-blocked` («rompe») si en Windows ninguna de las dos formas de cambiar la unión anduvo con
 * algún tipo de toma. Nunca tira: un problema del sondeo es una nota. Primera corrida: 182 #13451 (anda).
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const L = require('./lab.js');

const wait = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_) { /* nada */ } };
const errCode = (e) => (e && (e.code || e.message)) || String(e);

function makeLink(target, at, isWin) { fs.symlinkSync(target, at, isWin ? 'junction' : 'dir'); }
function removeLink(at) { try { fs.unlinkSync(at); } catch (_) { fs.rmdirSync(at); } }
function readMark(dir) { try { return fs.readFileSync(path.join(dir, 'mark.txt'), 'utf8').trim(); } catch (e) { return `ilegible (${errCode(e)})`; } }
function alive(p) { return Boolean(p) && p.exitCode === null && p.signalCode === null; }
const kill = (p) => { if (p) { try { p.kill(); } catch (_) { /* ya */ } } };
const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** Una versión de juguete: una marca, un archivo para tomar, una subcarpeta y los dos guiones que dicen dónde corren. */
function makeVersion(dir, mark) {
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'mark.txt'), `${mark}\n`);
  fs.writeFileSync(path.join(dir, 'held.txt'), 'tomado\n');
  fs.writeFileSync(path.join(dir, 'sub', 'inner.txt'), 'adentro\n');
  fs.writeFileSync(path.join(dir, 'scripts', 'where.js'), "const fs=require('fs');process.stdout.write(JSON.stringify({dirname:__dirname,filename:__filename,realpath:fs.realpathSync(__filename),main:require.main.filename,argv1:process.argv[1]}))\n");
  fs.writeFileSync(path.join(dir, 'scripts', 'where.ps1'), '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\nWrite-Output ("root=" + $PSScriptRoot)\nWrite-Output ("cmd=" + $PSCommandPath)\n');
}

/** Los que toman la carpeta, por la ruta de la unión. En posix el archivo y la carpeta de trabajo se arman igual. */
function holders(kind, dir, env, isWin) {
  const ps = L.scanPath('pwsh', { env })[0] || L.scanPath('powershell', { env })[0];
  const out = [];
  if (kind === 'file' || kind === 'all') {
    const f = path.join(dir, 'held.txt');
    if (isWin && ps) out.push(spawn(ps, ['-NoProfile', '-NonInteractive', '-Command', `$f = [System.IO.File]::Open(${quote(f)}, 'Open', 'Read', 'None'); Start-Sleep -Seconds 600`], { env, stdio: 'ignore', windowsHide: true }));
    else out.push(spawn(process.execPath, ['-e', 'require("fs").openSync(process.argv[1],"r");setTimeout(()=>{},600000)', f], { env, stdio: 'ignore', windowsHide: true }));
  }
  if (kind === 'cwd' || kind === 'all') out.push(spawn(process.execPath, ['-e', 'setTimeout(()=>{},600000)'], { cwd: path.join(dir, 'sub'), env, stdio: 'ignore', windowsHide: true }));
  if ((kind === 'watcher' || kind === 'all') && isWin && ps) {
    const script = `$w = New-Object System.IO.FileSystemWatcher ${quote(dir)}; $w.IncludeSubdirectories = $true; $w.EnableRaisingEvents = $true; Start-Sleep -Seconds 600`;
    out.push(spawn(ps, ['-NoProfile', '-NonInteractive', '-Command', script], { env, stdio: 'ignore', windowsHide: true }));
  }
  return out;
}

/** Cambia `at` para que apunte a `target`, de una de las dos formas. `{ ok, ms, code, back }`. */
function retarget(at, target, how, isWin) {
  const t0 = Date.now();
  const tmp = `${at}.new-${process.pid}`;
  try { removeLink(tmp); } catch (_) { /* no había */ }
  try { makeLink(target, tmp, isWin); } catch (e) { return { ok: false, ms: Date.now() - t0, code: `temporal: ${errCode(e)}`, back: null }; }
  try {
    if (how === 'aside') {
      const aside = `${at}.old-${process.pid}`;
      fs.renameSync(at, aside);
      fs.renameSync(tmp, at);
      removeLink(aside);
    } else if (isWin) {
      removeLink(at);
      fs.renameSync(tmp, at);
    } else fs.renameSync(tmp, at);   // posix: el reemplazo es atómico
    return { ok: true, ms: Date.now() - t0, code: null, back: null };
  } catch (e) {
    let back = null;
    try { fs.lstatSync(at); } catch (_) { try { makeLink(target, at, isWin); back = 'recreada'; } catch (e2) { back = `no se pudo recrear (${errCode(e2)})`; } }
    try { removeLink(tmp); } catch (_) { /* nada */ }
    return { ok: false, ms: Date.now() - t0, code: errCode(e), back };
  }
}

function walk(dir) {
  const acc = [];
  const go = (d, rel) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) { const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) go(path.join(d, e.name), r); else acc.push(r); }
  };
  go(dir, '');
  return acc;
}

function measureLinks({ base, env, rec, isWin = L.isWin() }) {
  const root = path.join(base, 'links-spike');
  const out = { lab_mode: !isWin, cases: {}, chain: null, where: null, partial_delete: null };
  try {
    fs.rmSync(root, { recursive: true, force: true });
    const v1 = path.join(root, 'versions', 'v1'), v2 = path.join(root, 'versions', 'v2');
    makeVersion(v1, 'v1');
    makeVersion(v2, 'v2');
    const harness = path.join(root, 'harness');
    const chain = path.join(root, 'claude-tycon-harness');
    makeLink(v1, harness, isWin);
    makeLink(harness, chain, isWin);

    // (c) dónde se creen que corren los guiones
    const node = (p) => { const r = L.run(process.execPath, [p], { env, timeoutMs: 30000, cap: 4000 }); try { return JSON.parse(r.stdout); } catch (_) { return { exit: r.exit, out: L.firstLine(`${r.stdout}\n${r.stderr}`) }; } };
    const psRun = (bin, p) => { const r = L.run(bin, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', p], { env, timeoutMs: 60000, cap: 4000 }); return { exit: r.exit, out: `${r.stdout}`.split('\n').map((l) => l.trim()).filter(Boolean) }; };
    const pwsh7 = L.scanPath('pwsh', { env })[0] || null;
    const ps51 = isWin ? (L.scanPath('powershell', { env })[0] || null) : null;
    out.where = {
      node_by_link: node(path.join(harness, 'scripts', 'where.js')),
      node_by_chain: node(path.join(chain, 'scripts', 'where.js')),
      pwsh7_by_link: pwsh7 ? psRun(pwsh7, path.join(harness, 'scripts', 'where.ps1')) : 'sin pwsh',
      pwsh7_by_chain: pwsh7 ? psRun(pwsh7, path.join(chain, 'scripts', 'where.ps1')) : 'sin pwsh',
      ps51_by_link: ps51 ? psRun(ps51, path.join(harness, 'scripts', 'where.ps1')) : 'sin powershell 5.1',
    };

    // (a) cada forma de tomar la carpeta vieja, y las tres juntas
    for (const kind of ['file', 'cwd', 'watcher', 'all']) {
      const c = {};
      for (const how of ['remove', 'aside']) {
        // cada intento arranca con la unión en v1 y los que toman, recién lanzados, por la unión
        const s = retarget(harness, v1, 'remove', isWin);
        if (!s.ok) { c[how] = { setup: s.code }; continue; }
        const hs = holders(kind, harness, env, isWin);
        wait(2500);
        const aliveBefore = hs.map(alive);
        const r = retarget(harness, v2, how, isWin);
        c[how] = { ok: r.ok, ms: r.ms, code: r.code, back: r.back, now: readMark(harness), chain: readMark(chain), holders: hs.length, alive_before: aliveBefore, alive_after: hs.map(alive) };
        for (const h of hs) kill(h);
        wait(800);
      }
      // la carpeta vieja tomada: ¿se deja renombrar? (la limpieza lo usa para saber si está libre) · Move-Item de la unión
      const s = retarget(harness, v1, 'remove', isWin);
      if (!s.ok) c.setup = s.code;
      const hs = holders(kind, harness, env, isWin);
      wait(2500);
      const renamed = `${v1}-renamed`;
      try { fs.renameSync(v1, renamed); c.rename_version_dir = 'ok'; fs.renameSync(renamed, v1); } catch (e) { c.rename_version_dir = errCode(e); }
      if (isWin && (pwsh7 || ps51)) {
        const moved = `${harness}.moved`;
        const r = L.run(pwsh7 || ps51, ['-NoProfile', '-NonInteractive', '-Command', `Move-Item -LiteralPath ${quote(harness)} -Destination ${quote(moved)} -ErrorAction Stop; Move-Item -LiteralPath ${quote(moved)} -Destination ${quote(harness)} -ErrorAction Stop; 'ok'`], { env, timeoutMs: 60000, cap: 2000 });
        c.move_item_link = r.exit === 0 ? `ok (sigue en ${readMark(harness)}; v1 entera: ${fs.existsSync(path.join(v1, 'mark.txt'))})` : `salió ${r.exit}: ${L.firstLine(r.stderr || r.stdout)}`;
      }
      c.alive_end = hs.map(alive);
      for (const h of hs) kill(h);
      wait(800);
      out.cases[kind] = c;
    }

    // el borrado recursivo de una carpeta con un archivo tomado: ¿borra a medias?
    const v3 = path.join(root, 'versions', 'v3');
    makeVersion(v3, 'v3');
    const hs = holders('file', v3, env, isWin);
    wait(2500);
    let rm = 'ok';
    try { fs.rmSync(v3, { recursive: true, force: true }); } catch (e) { rm = errCode(e); }
    out.partial_delete = { rm, left: fs.existsSync(v3) ? walk(v3) : [] };
    for (const h of hs) kill(h);

    // (b) la cadena con la unión vuelta a v1 y otra vez a v2, sin nadie tomando
    const b1 = retarget(harness, v1, 'remove', isWin);
    const before = readMark(chain);
    const b2 = retarget(harness, v2, 'remove', isWin);
    out.chain = { ok: b1.ok && b2.ok, before, after: readMark(chain) };
  } catch (e) {
    rec.note(`sondeo de la unión (8.33): no pude terminarlo (${errCode(e)}): lo medido hasta acá queda en links_spike`);
  }
  rec.fact('links_spike', out);
  if (isWin) {
    const moved = (c, how) => Boolean(c[how] && c[how].ok && c[how].now === 'v2');
    const blocked = Object.entries(out.cases).filter(([, c]) => !moved(c, 'remove') && !moved(c, 'aside')).map(([k]) => k);
    if (blocked.length) rec.finding('no-clone:links-retarget-blocked', 'links-spike', `la unión no se pudo cambiar de versión con la carpeta vieja tomada (${blocked.join(', ')}): la story 8.33 se para`, 'W8', { severity: 'breaks' });
  } else rec.note('sondeo de la unión (8.33): fuera de Windows nada se traba; la parte (a) no se mide');
  return out;
}

module.exports = { measureLinks, retarget, holders, alive };
