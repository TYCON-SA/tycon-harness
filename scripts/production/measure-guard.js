#!/usr/bin/env node
/**
 * measure-guard.js — ¿cuánto frenaría el freno de producción sobre el trabajo REAL de esta máquina?
 *
 * Pasa por el freno los últimos N comandos de terminal de las transcripciones de Claude Code
 * (~/.claude/projects/) y cuenta cuántos frena y por qué, separando los que nombran bases o el Llavero
 * de los que NO. Los segundos son falsos positivos: un freno que frena trabajo normal se apaga.
 *
 * POR QUÉ EXISTE (story 6.1, Task 3): la primera versión de la regla de escrituras, que pasaba todas las
 * pruebas, frenaba 313 de 4.000 comandos reales (7,8 %) que no tocaban ninguna base — un `find` con
 * `*.json`, un `rm -rf node_modules/*`. Ninguna prueba lo había visto; lo vio esta medición. Umbral en
 * guides/produccion-con-permiso.md: **0 frenados que no nombran bases** antes de instalar.
 *
 * PRIVACIDAD: no imprime ningún comando; sólo cuenta y agrupa motivos (con los valores entre «…» tapados). Los frenados
 * por un guion guardado se listan aparte con la ruta del guion, para que una persona los mire uno por uno.
 *
 * CADA COMANDO CORRE EN SU CARPETA: el `cwd` del renglón de la transcripción va al freno (en el evento y como carpeta del
 * proceso). Sin eso, `bash scripts/x.sh`, `npm run x` o `make x` se buscaban en la carpeta de la medición. Un comando
 * cuya carpeta ya no existe (un worktree borrado) no se puede medir: se cuenta en `sin_carpeta`.
 *
 * Sale 1 si hay falsos positivos, si algo no se pudo medir (tiempo agotado, el freno se cayó) o si no quedó ningún
 * comando medido: «no lo pude medir» nunca cuenta como «pasó limpio». Los worktrees se borran, así que `sin_carpeta` por sí
 * solo no hace salir 1: se muestra aparte, junto con cuántos comandos se midieron de verdad.
 *
 * Uso: node measure-guard.js [N=4000] [raiz-de-repos]
 */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), { spawnSync } = require('child_process');
const HOOK = path.join(__dirname, '..', 'hooks', 'prod-access-guard.js');
const N = Number(process.argv[2] || 4000);
const proj = path.join(os.homedir(), '.claude', 'projects');
const cmds = [];
for (const d of fs.readdirSync(proj)) {
  const dir = path.join(proj, d); let fsx; try { fsx = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
  for (const f of fsx) {
    let txt; try { txt = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    for (const l of txt.split('\n')) {
      if (!l.includes('"Bash"')) continue;
      try { const j = JSON.parse(l); const c = (j.message && j.message.content) || [];
        // la carpeta del renglón va con el comando: el freno resuelve contra ella los guiones, `npm run` y `make`
        for (const x of Array.isArray(c) ? c : []) if (x.type === 'tool_use' && x.name === 'Bash' && x.input && x.input.command) cmds.push({ c: x.input.command, cwd: typeof j.cwd === 'string' ? j.cwd : null });
      } catch {}
    }
  }
}
const muestra = cmds.slice(-N);
// La raíz de repos: 3er argumento, o la que resuelve el arnés (story 8.3: nunca una carpeta escrita a mano;
// sin raíz no se puede medir, y eso se dice).
const RAIZ_REPOS = process.argv[3] || (() => {
  const r = require(path.join(__dirname, '..', 'lib', 'repos-root.js')).resolveReposRoot();
  if (!r.root) { console.error(`measure-guard: no medido — sin raíz de repos (${r.motivo}). Pasala como 3er argumento o definí TYCON_REPOS_ROOT.`); process.exit(2); }
  // todas las carpetas de repos, en la forma que el freno lee de TYCON_REPOS_ROOT (separadas como en el PATH)
  return (Array.isArray(r.roots) && r.roots.length ? r.roots : [r.root]).join(path.delimiter);
})();
const casa = fs.mkdtempSync(path.join(os.tmpdir(), 'measure-guard-'));
fs.mkdirSync(path.join(casa, '.claude', 'shell-snapshots'), { recursive: true });
// 🔴 El criterio de «esto nombra bases» se LEE DEL FRENO, no se copia acá. Era una copia más pobre
// (sin el catálogo, sin el índice, sin la memoria, sin varios clientes), así que un freno correcto
// sobre `.tycon/production.json` se contaba como FALSO POSITIVO y el umbral de la guía —0 frenados
// que no nombran bases— era imposible de cumplir con el freno funcionando bien (2026-09-15).
const CRUDO = (() => {
  const src = fs.readFileSync(HOOK, 'utf8');
  const trozos = [/const CLIENTES = \{[\s\S]*?\n\};/, /const VARIABLES_SERVIDOR = \[[^\]]*\];/,
                  /const escRe = [^\n]*;/, /const CRUDO = new RegExp\([\s\S]*?'i'\);/]
    .map((re) => { const m = re.exec(src); if (!m) throw new Error('no pude leer el criterio del freno: ' + re); return m[0]; });
  return new Function(`${trozos.join('\n')}\nreturn CRUDO;`)();
})();
const motivos = {}; let frenados = 0, nombranBases = 0, frenadosSinBase = 0;
// 🔴 Lo que NO se pudo medir se cuenta aparte y no se pinta de verde: un comando que hizo que el
// freno se colgara (tiempo agotado) o que se cayera (cualquier salida que no sea 0 ni 2) no es «pasó
// limpio» — es justo el caso que en la máquina del dev deja pasar todo. Antes iban con los que
// pasan, así que un freno que se cae en 300 comandos medía 0 falsos positivos (Step 5, 2026-09-15).
let sinTiempo = 0, caidos = 0, sinCarpeta = 0;
// Los frenados porque un guion guardado, un `npm run` o un `make` nombra algo DECLARADO (un llavero, un servidor de
// producción) o llama a la puerta: nombran bases por definición, pero se listan aparte para que una persona los mire.
const porGuion = {}; let frenadosPorGuion = 0;
// Apretar la pantalla se frena a propósito y no nombra ninguna base: tampoco es un falso positivo.
let frenadosPorPantalla = 0;
const RELOJ_MS = 8000;
// el freno corre con un HOME falso: `~/x.sh` tiene que seguir apuntando al archivo de verdad
const conHomeReal = (c) => c.replace(/(^|[\s'"=])~\//g, `$1${os.homedir()}/`);
const existeCarpeta = (d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } };
for (const { c, cwd } of muestra) {
  // 🔴 sin la carpeta del comando, sus rutas relativas se buscarían acá y la capa de los guiones no mediría nada
  if (cwd && !existeCarpeta(cwd)) { sinCarpeta++; continue; }
  const r = spawnSync('node', [HOOK], { windowsHide: true, cwd: cwd || undefined,
    input: JSON.stringify({ tool_name: 'Bash', cwd: cwd || undefined, tool_input: { command: conHomeReal(c) } }),
    env: { PATH: process.env.PATH, HOME: casa, TYCON_REPOS_ROOT: RAIZ_REPOS, TYCON_PROD_SESSION_SINCE: '0' }, encoding: 'utf8', timeout: RELOJ_MS });
  const motivo = (r.stderr && (r.stderr.match(/Motivo: ([^\n]*)/) || [])[1]) || '';
  const delGuion = / y este comando lo corre\.$/.test(motivo);
  const porPantalla = /aprieta botones o teclas de la pantalla/.test(motivo);
  const nombra = CRUDO.test(c) || delGuion; if (nombra) nombranBases++;
  if (r.error && r.error.code === 'ETIMEDOUT') { sinTiempo++; continue; }
  if (r.status === 2) {
    frenados++; if (porPantalla) frenadosPorPantalla++; else if (!nombra) frenadosSinBase++;
    const m = (motivo || 'sin motivo').replace(/«[^»]*»/g, '«…»').replace(/\d+ KB/g, 'N KB').slice(0, 90);
    motivos[m] = (motivos[m] || 0) + 1;
    if (delGuion) { frenadosPorGuion++; const g = motivo.replace(/«[^»]*»/g, '«…»').slice(0, 160); porGuion[g] = (porGuion[g] || 0) + 1; }
  } else if (r.status !== 0) { caidos++; }
}
const medidos = muestra.length - sinCarpeta - sinTiempo - caidos;
const salida = { comandos_en_transcripciones: cmds.length, muestra: muestra.length, medidos, nombran_bases_o_llavero: nombranBases,
  frenados, frenados_que_no_nombran_bases: frenadosSinBase, frenados_por_apretar_la_pantalla: frenadosPorPantalla,
  frenados_por_guion_guardado: frenadosPorGuion, guiones_que_frenan: porGuion,
  no_medidos: { sin_tiempo: sinTiempo, se_cayo_el_freno: caidos, sin_carpeta: sinCarpeta, reloj_ms: RELOJ_MS }, motivos };
console.log(JSON.stringify(salida, null, 2));
// el umbral de la guía: 0 frenados que no nombran bases, nada sin medir por culpa del freno, y algo medido
if (frenadosSinBase || sinTiempo || caidos || medidos <= 0) process.exitCode = 1;
