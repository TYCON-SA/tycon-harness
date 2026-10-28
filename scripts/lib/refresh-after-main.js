'use strict';
/**
 * refresh-after-main.js — ¿la firma que pide un cambio de control es sólo la de haber traído `main`?
 *
 * Un pedido con un cambio de control firmado por el dueño que trae `main` cambia el blob de lo firmado aunque el cambio
 * propio sea el mismo: la firma se repite. Este módulo dice cuándo esa firma es una refirma (`refresh-after-main`, que
 * se puede delegar) y cuándo es un cambio de control (`control-change`, sólo del dueño). Ante cualquier duda, cambio de
 * control.
 *
 * Es refirma sólo si una constancia del dueño (sin `via`) que agregó este pedido (su hash no está en la base) cubre cada
 * entrada {p, B2} así: un commit C del pedido (en `merge-base(punta, base)..punta`) tiene p con el blob firmado B1; el
 * ancestro O1 = blob(merge-base(C, base), p) y lo traído O2 = blob(merge-base(punta, base), p) los calcula este módulo
 * desde el historial; `git merge-file` (actual O2, ancestro O1, otro B1) no tiene conflictos y da exactamente B2; y p es
 * un archivo común con el mismo modo en C y en la punta. Una ruta ausente en algún lado, un archivo nuevo, un conflicto,
 * un commit que no está (clon superficial) o cualquier error de git es cambio de control.
 *
 * Lo usan el freno (por el guion), `run-base-controls.sh approve` y la CI; la CI carga la copia de la base. Por eso sólo
 * usa módulos de Node: se puede cargar desde un archivo suelto.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REFIRMA = 'refresh-after-main';
const CONTROL = 'control-change';
// un pedido con más commits que éstos no se recorre: se firma como cambio de control
const MAX_COMMITS = 5000;
const COMUNES = new Set(['100644', '100755']);

const GIT_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(DIR|INDEX_FILE|WORK_TREE|COMMON_DIR|PREFIX|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES)$/.test(k)));

class NoSe extends Error {}

function git(root, args, input) {
  const r = spawnSync('git', ['-C', root, '-c', 'core.quotePath=false', ...args], { encoding: 'utf8', input, env: GIT_ENV, maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw new NoSe(`git ${args[0]}: ${r.error.message}`);
  return r;
}
function una(root, args) {
  const r = git(root, args);
  if (r.status !== 0) throw new NoSe(`git ${args[0]}: ${(r.stderr || '').trim().split('\n')[0] || `salió ${r.status}`}`);
  return r.stdout.replace(/\n+$/, '');
}
function commitDe(root, rev) {
  const r = git(root, ['rev-parse', '--verify', '-q', `${rev}^{commit}`]);
  if (r.status !== 0) throw new NoSe(`no encuentro el commit ${String(rev).slice(0, 40)}`);
  return r.stdout.trim();
}
function mergeBase(root, a, b) {
  const r = git(root, ['merge-base', a, b]);
  if (r.status !== 0 || !r.stdout.trim()) throw new NoSe(`no hay ancestro común entre ${a.slice(0, 12)} y ${b.slice(0, 12)}`);
  return r.stdout.trim();
}
// { modo, tipo, blob } de la ruta exacta en un commit, o null si no está
function entradaDe(root, rev, p) {
  const r = git(root, ['ls-tree', '-z', rev, '--', p]);
  if (r.status !== 0) throw new NoSe(`no pude leer ${p} en ${rev.slice(0, 12)}`);
  for (const rec of r.stdout.split('\0').filter(Boolean)) {
    const tab = rec.indexOf('\t');
    const [modo, tipo, blob] = rec.slice(0, tab).split(' ');
    if (rec.slice(tab + 1) === p) return { modo, tipo, blob };
  }
  return null;
}
const comun = (e) => !!e && e.tipo === 'blob' && COMUNES.has(e.modo);

/** Las constancias que pueden ser la anterior de una refirma: del dueño (sin `via`) y que no están en la base. */
function anteriores(approvals, baseHashes) {
  const enBase = baseHashes instanceof Set ? baseHashes : new Set(baseHashes || []);
  return (approvals || []).filter((a) => a && a.via === undefined && typeof a.hash === 'string' && Array.isArray(a.rules) && !enBase.has(a.hash));
}

// ¿la entrada {p, B2} es lo que da traer main sobre lo que firmó la constancia? null si sí; el motivo si no
function porQueNo(ctx, anterior, e) {
  const { root, mb, baseC, tipC, commits, tmp } = ctx;
  const regla = anterior.rules.find((r) => r && r.path === e.path);
  if (!regla || typeof regla.blob !== 'string') return `${e.path} no está en la constancia anterior`;
  const punta = entradaDe(root, tipC, e.path);
  if (!punta) return `${e.path} no está en la punta del pedido`;
  if (!comun(punta)) return `${e.path} no es un archivo común en la punta`;
  if (punta.blob !== e.blob) return `${e.path} en la punta no es el blob que se firma`;
  if (regla.blob === e.blob) return `${e.path} ya está firmado tal cual`;
  const c = commits.find((h) => { const x = entradaDe(root, h, e.path); return x && x.blob === regla.blob; });
  if (!c) return `ningún commit del pedido tiene ${e.path} como lo firmó el dueño`;
  const enC = entradaDe(root, c, e.path);
  if (!comun(enC) || enC.modo !== punta.modo) return `${e.path} cambió de modo o de tipo desde lo firmado`;
  const o1 = entradaDe(root, mergeBase(root, c, baseC), e.path);
  const o2 = entradaDe(root, mb, e.path);
  if (!comun(o1) || !comun(o2)) return `${e.path} no está como archivo común en main (nuevo, borrado o renombrado)`;
  if (o1.blob === o2.blob) return `main no cambió ${e.path}: no hay nada que traer`;
  const archivo = (nombre, blob) => {
    const f = path.join(tmp, nombre);
    const r = git(root, ['cat-file', 'blob', blob]);
    if (r.status !== 0) throw new NoSe(`no pude leer el blob ${blob.slice(0, 12)}`);
    fs.writeFileSync(f, r.stdout);
    return f;
  };
  const actual = archivo('actual', o2.blob);
  const ancestro = archivo('ancestro', o1.blob);
  const otro = archivo('otro', regla.blob);
  const m = spawnSync('git', ['merge-file', '-p', '-q', actual, ancestro, otro], { encoding: 'buffer', env: GIT_ENV, maxBuffer: 256 * 1024 * 1024 });
  if (m.error || m.status !== 0) return `traer main sobre ${e.path} no es limpio (conflicto o archivo que git no fusiona)`;
  const h = git(root, ['hash-object', '--stdin'], m.stdout);
  if (h.status !== 0) throw new NoSe('no pude calcular el blob de la fusión');
  if (h.stdout.trim() !== e.blob) return `${e.path} no es lo que da traer main sobre lo firmado`;
  return null;
}

/**
 * `{ clase: 'refresh-after-main', refirma_de, motivo }` o `{ clase: 'control-change', motivo }`.
 * `entries`: [{path, blob}] a firmar; `approvals`: las constancias del árbol del pedido; `baseHashes`: los hashes de las
 * constancias de la base (en cualquiera de sus rutas); `base`: la rama base; `tip`: la punta (HEAD).
 */
function classify({ root, base, tip = 'HEAD', entries, approvals, baseHashes } = {}) {
  const control = (motivo) => ({ clase: CONTROL, motivo });
  if (!base) return control('sin --base no se puede comprobar que sea sólo traer main');
  if (!Array.isArray(entries) || !entries.length || !entries.every((e) => e && typeof e.path === 'string' && typeof e.blob === 'string')) return control('no hay entradas que firmar');
  const candidatas = anteriores(approvals, baseHashes);
  if (!candidatas.length) {
    const delDueno = (approvals || []).some((a) => a && a.via === undefined);
    return control(delDueno ? 'la constancia anterior del dueño ya está en la base: no es de este pedido' : 'no hay una constancia anterior del dueño en este pedido');
  }
  let tmp = null;
  try {
    if (!root || !fs.existsSync(root)) throw new NoSe('la carpeta del pedido no existe');
    const baseC = commitDe(root, base);
    const tipC = commitDe(root, tip);
    const mb = mergeBase(root, tipC, baseC);
    const lista = una(root, ['rev-list', `${mb}..${tipC}`]).split('\n').filter(Boolean);
    if (lista.length > MAX_COMMITS) return control(`el pedido tiene más de ${MAX_COMMITS} commits`);
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-after-main-'));
    const ctx = { root, mb, baseC, tipC, commits: lista, tmp };
    let motivo = null;
    for (const anterior of candidatas) {
      const no = entries.map((e) => porQueNo(ctx, anterior, e)).find((x) => x !== null);
      if (no === undefined) return { clase: REFIRMA, refirma_de: anterior.hash, motivo: 'es lo que da traer main sobre lo que el dueño firmó' };
      motivo = motivo || no;
    }
    return control(motivo);
  } catch (e) {
    return control(e instanceof NoSe ? e.message : `error al clasificar (${String((e && e.message) || e).split('\n')[0]})`);
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { REFIRMA, CONTROL, classify, anteriores };
