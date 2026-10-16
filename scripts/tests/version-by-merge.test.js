'use strict';

/**
 * version-by-merge.test.js — el número de versión lo pone el merge, no cada pedido.
 *
 * Una máquina instalada compara números `AAAA.MM.DD.N` para saber si hay algo nuevo. Con `numbering: "merge-tag"` en
 * `version.json`, el número de un commit es el de su etiqueta `v<número>` (la pone .github/workflows/version-tag.yml
 * con scripts/ci/version-tag.js después de que el merge entra a main); el `version` del archivo queda fijo como piso,
 * que es lo que mira una máquina con el código de antes. Lo que no puede pasar:
 *   · que dos merges tomen el mismo número, o que el número baje (un reloj atrasado, el piso, la etiqueta de ayer);
 *   · que una máquina quede sin actualizarse: la vieja (mira el archivo) ve el piso subir una vez; la nueva lee la
 *     etiqueta, y una punta que todavía no la tiene espera en silencio —y lo dice si la espera pasa de unas horas—;
 *   · que una punta que se miró antes de su etiqueta quede recordada con el piso y no se baje nunca;
 *   · que un pedido toque el número cuando lo pone el merge, o que saque la marca;
 *   · que el workflow que etiqueta cambie de forma sin que se diga, o que aparezca otro con permiso de escritura.
 *
 * Todo corre sobre repos de juguete (git de verdad) y clientes de mentira: no sale a la red.
 *
 * stable-data: T13 y T20 miden la espera de la etiqueta contra el reloj de verdad a propósito (es lo que hace la máquina:
 * «hace cuántas horas»), con márgenes de horas; los commits igual llevan fecha fija y el mantenimiento de git apagado.
 *
 * Correr: node --test scripts/tests/version-by-merge.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const VO = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'version-order.js'));
const PG = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'public-git.js'));
const SRC = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'sources.js'));
const RL = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'release.js'));
const REPORT = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'report.js'));
const VT = require(path.join(ROOT, 'scripts', 'ci', 'version-tag.js'));
const WF = require(path.join(ROOT, 'scripts', 'ci', 'check-public-workflow.js'));
const TOOL = path.join(ROOT, 'scripts', 'ci', 'version-tag.js');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'version-by-merge-'));
test.after(() => { fs.rmSync(SCRATCH, { recursive: true, force: true }); });

// un git sin la configuración de la máquina (sus hooks globales, su firma) ni la del proceso que corre la prueba
const EMPTY_CONFIG = path.join(SCRATCH, 'gitconfig-vacio');
fs.writeFileSync(EMPTY_CONFIG, '');
// commits con fecha fija (el sha sale siempre igual) y sin el mantenimiento automático de git, que queda corriendo
// desprendido y toca el `.git` del laboratorio
const ENV = (() => {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^GIT_/.test(k)) env[k] = v;
  return Object.assign(env, { GIT_CONFIG_GLOBAL: EMPTY_CONFIG, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'maintenance.auto', GIT_CONFIG_VALUE_0: 'false',
    GIT_AUTHOR_DATE: '2030-01-15T12:00:00Z', GIT_COMMITTER_DATE: '2030-01-15T12:00:00Z',
    GIT_AUTHOR_NAME: 'Prueba', GIT_AUTHOR_EMAIL: 'prueba@example.invalid', GIT_COMMITTER_NAME: 'Prueba', GIT_COMMITTER_EMAIL: 'prueba@example.invalid' });
})();
const git = (dir, args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const FLOOR = '2030.01.15.7';
const marked = (version) => `${JSON.stringify({ version, numbering: 'merge-tag', source: { harness: 'x' }, transformed: [] }, null, 2)}\n`;
const plain = (version) => `${JSON.stringify({ version, source: { harness: 'x' }, transformed: [] }, null, 2)}\n`;

let serial = 0;
/** Un remoto desnudo y un clon con un primer commit; `text` es el version.json. */
function toy(text = marked(FLOOR)) {
  const base = path.join(SCRATCH, `r${serial += 1}`);
  const pub = path.join(base, 'pub.git');
  const work = path.join(base, 'work');
  fs.mkdirSync(base, { recursive: true });
  execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', pub], { env: ENV });
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', work], { env: ENV });
  fs.writeFileSync(path.join(work, 'version.json'), text);
  git(work, ['add', '-A']);
  git(work, ['commit', '--quiet', '-m', 'inicio']);
  git(work, ['remote', 'add', 'origin', pub]);
  git(work, ['push', '--quiet', 'origin', 'main']);
  return { pub, work };
}
/** Un commit más en main, empujado (lo que deja la cola al mergear). */
function merge(work, name) {
  fs.writeFileSync(path.join(work, `${name}.txt`), `${name}\n`);
  git(work, ['add', '-A']);
  git(work, ['commit', '--quiet', '-m', name]);
  git(work, ['push', '--quiet', 'origin', 'main']);
  return git(work, ['rev-parse', 'HEAD']);
}
const tagCli = (work, sha, today, extra = []) => spawnSync(process.execPath, [TOOL, 'tag', '--root', work, '--sha', sha, '--today', today, ...extra], { encoding: 'utf8', env: ENV });
const remoteTags = (pub) => git(pub, ['tag', '--list', 'v*']).split('\n').filter(Boolean).sort();

// ── el número por etiqueta, en la librería compartida ────────────────────────────────────────────────────────────────
test('T1 VersionOrder_TagHelpers_OnlyNumberedTagsCount', () => {
  assert.strictEqual(VO.fromTag('v2030.01.15.3'), '2030.01.15.3');
  assert.strictEqual(VO.fromTag('refs/tags/v2030.01.15.3'), '2030.01.15.3');
  for (const bad of ['2030.01.15.3', 'v2030.1.15.3', 'v2030.01.15.0', 'vX', 'release-1', '', null]) assert.strictEqual(VO.fromTag(bad), null, `${bad} no es un número`);
  assert.strictEqual(VO.tagName('2030.01.15.3'), 'v2030.01.15.3');
  assert.strictEqual(VO.bestTag(['v2030.01.15.9', 'v2030.01.15.10', 'otra', 'v2030.01.14.99']), '2030.01.15.10', 'por partes numéricas, no como texto');
  assert.strictEqual(VO.bestTag([]), null);
  assert.strictEqual(VO.numberedByTag({ version: FLOOR, numbering: 'merge-tag' }), true);
  assert.strictEqual(VO.numberedByTag({ version: FLOOR }), false);
  assert.strictEqual(VO.numberedByTag(null), false);
});

test('T2 ParseInfoRefs_ReadsTags_AnnotatedPeeled', () => {
  const pkt = (t) => `${(Buffer.byteLength(t, 'latin1') + 4).toString(16).padStart(4, '0')}${t}`;
  const advert = (lines) => Buffer.from(`${pkt('# service=git-upload-pack\n')}0000${lines.map(pkt).join('')}0000`, 'latin1');
  const [A, B, T] = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)];
  const r = PG.parseInfoRefs(advert([
    `${A} refs/heads/main\0multi_ack agent=x\n`,
    `${A} refs/tags/v2030.01.15.8\n`,
    `${T} refs/tags/v2030.01.15.9\n`,
    `${B} refs/tags/v2030.01.15.9^{}\n`,
  ]));
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.heads, { main: A });
  assert.deepStrictEqual(r.tags, { 'v2030.01.15.8': A }, 'sólo las livianas (las del merge): una anotada no numera, igual que en la API y en un clon');
  assert.strictEqual(B.length, 40);
});

// ── el número que sigue ──────────────────────────────────────────────────────────────────────────────────────────────
test('T3 NextNumber_AboveTagsAndFloor_NeverBackwards', () => {
  assert.strictEqual(VT.nextNumber({ today: '2030.01.15', tags: [], floor: FLOOR }), '2030.01.15.8', 'el mismo día que el piso: arriba del piso');
  assert.strictEqual(VT.nextNumber({ today: '2030.01.16', tags: [], floor: FLOOR }), '2030.01.16.1');
  assert.strictEqual(VT.nextNumber({ today: '2030.01.16', tags: ['v2030.01.16.1', 'v2030.01.16.2'], floor: FLOOR }), '2030.01.16.3');
  // un reloj atrasado (o una corrida que tardó) no da un número menor que el último
  assert.strictEqual(VT.nextNumber({ today: '2030.01.14', tags: ['v2030.01.16.4'], floor: FLOOR }), '2030.01.16.5');
  assert.strictEqual(VT.nextNumber({ today: '2030.01.14', tags: [], floor: FLOOR }), '2030.01.15.8');
  // las etiquetas que no son de número no cuentan
  assert.strictEqual(VT.nextNumber({ today: '2030.01.16', tags: ['release', 'v1'], floor: FLOOR }), '2030.01.16.1');
});

test('T4 Decide_TaggedOrNotTip_DoesNothing', () => {
  const sha = 'd'.repeat(40);
  assert.deepStrictEqual(VT.decide({ sha, isTip: true, today: '2030.01.16', tags: [], floor: FLOOR }), { action: 'tag', name: 'v2030.01.16.1', version: '2030.01.16.1' });
  const tagged = VT.decide({ sha, isTip: true, tipTags: ['v2030.01.16.1'], today: '2030.01.16', tags: ['v2030.01.16.1'], floor: FLOOR });
  assert.strictEqual(tagged.action, 'skip');
  assert.match(tagged.reason, /ya tiene su número/);
  const old = VT.decide({ sha, isTip: false, today: '2030.01.16', tags: [], floor: FLOOR });
  assert.strictEqual(old.action, 'skip');
  assert.match(old.reason, /ya no es la punta/);
});

test('T5 TagCli_RealRepos_SerialNumbers_IdempotentAndOnlyTheTip', () => {
  const { pub, work } = toy();
  const first = git(work, ['rev-parse', 'HEAD']);
  const a = tagCli(work, first, '2030.01.16');
  assert.strictEqual(a.status, 0, a.stderr);
  assert.match(a.stdout, /v2030\.01\.16\.1/);
  assert.deepStrictEqual(remoteTags(pub), ['v2030.01.16.1']);
  // otra vez sobre el mismo commit: nada
  const again = tagCli(work, first, '2030.01.16');
  assert.strictEqual(again.status, 0);
  assert.match(again.stdout, /ya tiene su número/);
  // dos merges seguidos: la corrida del primero llega tarde (ya no es la punta) y no numera; la del segundo, sí
  const second = merge(work, 'b');
  const third = merge(work, 'c');
  const late = tagCli(work, second, '2030.01.16');
  assert.strictEqual(late.status, 0);
  assert.match(late.stdout, /ya no es la punta/);
  assert.strictEqual(tagCli(work, third, '2030.01.16').status, 0);
  assert.deepStrictEqual(remoteTags(pub), ['v2030.01.16.1', 'v2030.01.16.2']);
  assert.strictEqual(git(pub, ['rev-list', '-n', '1', 'v2030.01.16.2']), third);
  // --dry-run no crea ni empuja
  const fourth = merge(work, 'd');
  const dry = tagCli(work, fourth, '2030.01.16', ['--dry-run']);
  assert.match(dry.stdout, /pondría v2030\.01\.16\.3/);
  assert.deepStrictEqual(remoteTags(pub), ['v2030.01.16.1', 'v2030.01.16.2']);
  // un sha que no es un commit completo: no pude (2), nunca un verde
  assert.strictEqual(tagCli(work, 'abc', '2030.01.16').status, 2);
});

// ── el paso `version` de la CI pública ───────────────────────────────────────────────────────────────────────────────
test('T6 CheckPr_WithMark_NumberUntouched_WithoutMark_MustRise', () => {
  const m = (version) => ({ version, numbering: 'merge-tag' });
  assert.strictEqual(VT.checkPr(m(FLOOR), m(FLOOR)).ok, true);
  const bumped = VT.checkPr(m(FLOOR), m('2030.01.15.8'));
  assert.strictEqual(bumped.ok, false);
  assert.match(bumped.line, /lo pone el merge/);
  const unmarked = VT.checkPr(m(FLOOR), { version: FLOOR });
  assert.strictEqual(unmarked.ok, false);
  assert.match(unmarked.line, /marca/);
  // sin la marca en la base (antes de la transición): como siempre, el número sube
  assert.strictEqual(VT.checkPr({ version: FLOOR }, m('2030.01.15.8')).ok, true, 'el pedido de la transición: trae la marca y sube');
  assert.match(VT.checkPr({ version: FLOOR }, { version: FLOOR }).line, /cada pedido sube la versión/);
  assert.strictEqual(VT.checkPr(null, m(FLOOR)).ok, true, 'la base no numera versiones');
  assert.strictEqual(VT.checkPr(m(FLOOR), null).blocked, true, 'la punta sin version.json: no pude');
});

test('T7 CheckPrCli_ReadsBothCommits', () => {
  const { work } = toy();
  const base = git(work, ['rev-parse', 'HEAD']);
  const same = merge(work, 'x');
  const run = (tip) => spawnSync(process.execPath, [TOOL, 'check-pr', '--root', work, '--base', base, '--tip', tip], { encoding: 'utf8', env: ENV });
  assert.strictEqual(run(same).status, 0);
  fs.writeFileSync(path.join(work, 'version.json'), marked('2030.01.15.8'));
  git(work, ['commit', '--quiet', '-am', 'sube']);
  const r = run(git(work, ['rev-parse', 'HEAD']));
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /el pedido no toca version\.json/);
});

// ── las máquinas con clon ────────────────────────────────────────────────────────────────────────────────────────────
test('T8 Sources_VersionAt_TagWins_UntaggedIsPending', () => {
  const { work } = toy();
  const head = git(work, ['rev-parse', 'HEAD']);
  const before = SRC.versionAt(work, head, { env: ENV });
  assert.deepStrictEqual([before.status, before.version, Boolean(before.tagged), Boolean(before.pending)], ['ok', FLOOR, false, true], 'sin etiqueta: el piso, esperando');
  git(work, ['tag', 'v2030.01.16.4', head]);
  const after = SRC.versionAt(work, head, { env: ENV });
  assert.deepStrictEqual([after.status, after.version, Boolean(after.tagged), Boolean(after.pending)], ['ok', '2030.01.16.4', true, false]);
  // un commit de antes (sin la marca): su archivo, como siempre, con la misma forma de respuesta que antes
  const { work: old } = toy(plain(FLOOR));
  assert.deepStrictEqual(SRC.versionAt(old, 'HEAD', { env: ENV }), { status: 'ok', version: FLOOR, reason: null });
});

test('T9 Sources_Assess_PendingTipIsUpToDate_TaggedTipIsNew', () => {
  const { work } = toy();
  const installed = git(work, ['rev-parse', 'HEAD']);
  git(work, ['tag', 'v2030.01.16.1', installed]);
  const tip = merge(work, 'b');
  const src = { name: 'harness', dir: work, rewrites: true };
  const waiting = SRC.assess(src, installed, tip, { env: ENV });
  assert.deepStrictEqual([waiting.status, waiting.pending], ['up_to_date', true], 'la punta todavía sin etiqueta: no se aplica, y no es «más vieja»');
  git(work, ['tag', 'v2030.01.16.2', tip]);
  const now = SRC.assess(src, installed, tip, { env: ENV });
  assert.deepStrictEqual([now.status, now.numbers], ['new', { from: '2030.01.16.1', to: '2030.01.16.2' }]);
  // una máquina en un commit de antes de la transición (su archivo dice un número menor): la punta etiquetada es nueva
  const { work: w2 } = toy(plain('2030.01.15.6'));
  const before = git(w2, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(w2, 'version.json'), marked(FLOOR));
  git(w2, ['commit', '--quiet', '-am', 'la transición']);
  const transition = git(w2, ['rev-parse', 'HEAD']);
  assert.strictEqual(SRC.assess({ name: 'harness', dir: w2, rewrites: true }, before, transition, { env: ENV }).status, 'up_to_date', 'la transición sin etiqueta todavía espera');
  git(w2, ['tag', 'v2030.01.15.8', transition]);
  assert.strictEqual(SRC.assess({ name: 'harness', dir: w2, rewrites: true }, before, transition, { env: ENV }).status, 'new');
});

test('T10 Sources_Fetch_BringsTheTags', () => {
  const { pub, work } = toy();
  const clone = path.join(SCRATCH, `c${serial += 1}`);
  execFileSync('git', ['clone', '--quiet', '--no-tags', pub, clone], { env: ENV });
  const tip = merge(work, 'b');
  git(work, ['tag', 'v2030.01.16.1', tip]);
  git(work, ['push', '--quiet', 'origin', 'refs/tags/v2030.01.16.1']);
  const f = SRC.fetch({ name: 'harness', dir: clone, ref: 'main', rewrites: true }, { env: ENV, budgetS: 30 });
  assert.strictEqual(f.ok, true, f.reason);
  assert.strictEqual(SRC.versionAt(clone, 'refs/remotes/origin/main', { env: ENV }).version, '2030.01.16.1');
});

test('T11 Report_Derive_NumberIsTheTagAtHead', () => {
  const { work } = toy();
  const state = { tree: work, sources: [] };
  assert.strictEqual(REPORT.derive(state, { env: ENV }).number, FLOOR, 'sin etiqueta: el piso');
  git(work, ['tag', 'v2030.01.16.3', 'HEAD']);
  assert.strictEqual(REPORT.derive(state, { env: ENV }).number, '2030.01.16.3');
});

// ── las máquinas sin clon ────────────────────────────────────────────────────────────────────────────────────────────
/** Un cliente de mentira: el raw contesta el version.json que se le dé; la API no se usa (si se usa, la prueba falla). */
function fakeClient(rawByCommit) {
  const asked = [];
  return {
    asked,
    public: PG.bases({}),
    deadline: Date.now() + 60000,
    getPublic(url) {
      asked.push(url);
      const sha = Object.keys(rawByCommit).find((s) => url.includes(s));
      return sha ? { ok: true, status: 200, body: Buffer.from(rawByCommit[sha]) } : { ok: true, status: 404, body: Buffer.alloc(0) };
    },
    get(route) { throw new Error(`la API no se tenía que usar: ${route}`); },
  };
}

test('T12 Release_NumberAt_TagFirst_PendingIsNotRemembered', () => {
  const [A, B] = ['a'.repeat(40), 'b'.repeat(40)];
  const c = fakeClient({ [A]: marked(FLOOR), [B]: plain('2030.01.15.6') });
  const tips = {};
  const pending = RL.numberAt(c, 'o/n', A, tips, {});
  assert.deepStrictEqual([pending.version, pending.pending, Boolean(pending.tagged)], [FLOOR, true, false]);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(tips, A), false, 'la punta sin etiqueta no se recuerda con el piso');
  // llega la etiqueta: su número, sin pedir el raw
  const before = c.asked.length;
  const tagged = RL.numberAt(c, 'o/n', A, tips, { 'v2030.01.16.2': A });
  assert.deepStrictEqual([tagged.version, tagged.tagged], ['2030.01.16.2', true]);
  assert.strictEqual(c.asked.length, before, 'la etiqueta viene en info/refs: ningún pedido más');
  assert.strictEqual(tips[A], '2030.01.16.2');
  // aun si una mirada vieja dejó el piso recordado, la etiqueta gana
  assert.strictEqual(RL.numberAt(c, 'o/n', A, { [A]: FLOOR }, { 'v2030.01.16.2': A }).version, '2030.01.16.2');
  // un commit de antes (sin la marca): su archivo, recordado como siempre
  const old = RL.numberAt(c, 'o/n', B, tips, {});
  assert.deepStrictEqual([old.version, old.pending], ['2030.01.15.6', false]);
  assert.strictEqual(tips[B], '2030.01.15.6');
});

test('T13 Release_PendingTag_QuietFirst_SaysItAfterHours', () => {
  const t = { ref: 'main', commit: 'a'.repeat(40) };
  const src = { version: '2030.01.16.1', etags: {} };
  const quiet = RL.pendingTag(src, t, []);
  assert.deepStrictEqual([quiet.status, quiet.code], ['up_to_date', 0]);
  assert.match(quiet.lines[0], /todavía no tiene su número/);
  assert.strictEqual(src.etags.pending.sha, t.commit);
  // la misma punta, horas después: ya no es «recién entró»
  src.etags.pending.since = new Date(Date.now() - RL.PENDING_TAG_SAY_MS - 60000).toISOString();
  const loud = RL.pendingTag(src, t, []);
  assert.deepStrictEqual([loud.status, loud.code], ['blocked', 2]);
  assert.match(loud.lines[0], /ninguna máquina se actualiza/);
  // otra punta, también sin etiqueta: la cuenta NO vuelve a empezar (con merges seguidos el aviso saldría nunca)
  const other = RL.pendingTag(src, { ref: 'main', commit: 'b'.repeat(40) }, []);
  assert.strictEqual(other.status, 'blocked');
  // una mirada que ya no espera (la punta tiene su número) borra la racha: la próxima espera arranca de cero
  delete src.etags.pending;
  assert.strictEqual(RL.pendingTag(src, { ref: 'main', commit: 'c'.repeat(40) }, []).status, 'up_to_date');
});

test('T14 Release_TagsByApi_OnlyLightweightNumberedTags', () => {
  const c = {
    get(route) {
      assert.match(route, /\/git\/matching-refs\/tags\/v$/);
      return { ok: true, status: 200, json: [
        { ref: 'refs/tags/v2030.01.16.1', object: { type: 'commit', sha: 'a'.repeat(40) } },
        { ref: 'refs/tags/v2030.01.16.2', object: { type: 'tag', sha: 'f'.repeat(40) } },
      ] };
    },
  };
  const t = RL.tagsByApi(c, 'o/n');
  assert.deepStrictEqual(t, { ok: true, tags: { 'v2030.01.16.1': 'a'.repeat(40) } });
  assert.strictEqual(RL.tagNumberOf(t.tags, 'a'.repeat(40)), '2030.01.16.1');
  assert.strictEqual(RL.tagNumberOf(t.tags, 'b'.repeat(40)), null);
});

// ── los workflows del repo público ───────────────────────────────────────────────────────────────────────────────────
test('T15 Workflows_OnlyCiAndTagger_TaggerHasItsExactShape', () => {
  const dir = path.join(ROOT, '.github', 'workflows');
  if (!fs.existsSync(dir)) return;   // el repo del equipo no lleva la carpeta: la mira la copia pública
  assert.deepStrictEqual(WF.strayWorkflows(fs.readdirSync(dir)), [], 'en .github/workflows/ sólo la CI y el que etiqueta');
  assert.deepStrictEqual(WF.strayWorkflows(['ci.yml', 'version-tag.yml', 'otro.yml']), ['otro.yml']);
  const text = fs.readFileSync(path.join(dir, 'version-tag.yml'), 'utf8');
  assert.deepStrictEqual(WF.check(text, { tagger: true }), [], 'el workflow que etiqueta cumple su forma');
  const broken = (from, to) => WF.check(text.replace(from, to), { tagger: true }).map((b) => b.rule);
  assert.ok(broken('  contents: read\n', '  contents: write\n').includes('shape'), 'escritura para todo el workflow: rojo');
  assert.ok(broken('cancel-in-progress: false', 'cancel-in-progress: true').includes('shape'), 'cortar una corrida en fila: rojo');
  assert.ok(broken('  push:\n', '  pull_request_target:\n  push:\n').includes('pull-request-target'));
  assert.ok(broken('actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', `actions/checkout@${'e'.repeat(40)}`).includes('shape'), 'con escritura, otro sha de la acción: rojo');
  assert.ok(broken('run: node scripts/ci/version-tag.js', 'env:\n          T: ${{ secrets.X }}\n        run: node scripts/ci/version-tag.js').includes('secrets'));
  // el control de la CI sigue igual
  assert.deepStrictEqual(WF.check(fs.readFileSync(path.join(dir, 'ci.yml'), 'utf8')), []);
});

test('T16 RealVersionJson_CarriesTheMark', () => {
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'version.json'), 'utf8'));
  assert.strictEqual(VO.numberedByTag(j), true, 'version.json dice que el número lo pone el merge');
  assert.strictEqual(VO.isOrdered(j.version), true, 'y su piso tiene forma de número');
});

// ── lo que encontró la revisión de la transición ─────────────────────────────────────────────────────────────────────
test('T17 Release_CachedTip_KeepsTheTagMark_OldEntriesNotTrusted', () => {
  // la punta recordada con su ETag vuelve con su marca (un 304 no la pierde: sin ella la bajada se negaba)
  const fresh = { etag: '"e1"', sha: 'a'.repeat(40), version: '2030.01.16.1', tagged: true };
  assert.strictEqual(RL.trustedCache(fresh), true);
  assert.deepStrictEqual([RL.fromCache(fresh, 'main').version, RL.fromCache(fresh, 'main').tagged], ['2030.01.16.1', true]);
  // una entrada del código de antes (sin `tagged`): su número puede ser el piso; no se usa, se vuelve a mirar
  assert.strictEqual(RL.trustedCache({ etag: '"e1"', sha: 'a'.repeat(40), version: FLOOR }), false);
  assert.strictEqual(RL.trustedCache(null), false);
});

test('T18 Release_TreeNumber_FloorWithMark_ExactWithout', () => {
  const m = { version: FLOOR, numbering: 'merge-tag' };
  assert.strictEqual(RL.treeNumberOk(m, '2030.01.16.1'), true, 'la etiqueta, por encima del piso del árbol');
  assert.strictEqual(RL.treeNumberOk(m, FLOOR), true, 'la punta todavía sin etiqueta se baja con el piso');
  assert.strictEqual(RL.treeNumberOk(m, '2030.01.15.6'), false, 'un número menor que el piso del árbol: no cierra');
  assert.strictEqual(RL.treeNumberOk({ version: FLOOR }, FLOOR), true, 'sin la marca, el mismo número, como siempre');
  assert.strictEqual(RL.treeNumberOk({ version: FLOOR }, '2030.01.16.1'), false);
  assert.strictEqual(RL.treeNumberOk(null, FLOOR), false);
});

test('T19 Release_SameCommitGetsItsTag_AdoptsTheNumber', () => {
  const src = { version: FLOOR };
  const state = { version: { number: FLOOR } };
  assert.strictEqual(RL.adoptTag(src, state, { tagged: true, version: '2030.01.16.1' }), true);
  assert.deepStrictEqual([src.version, state.version.number], ['2030.01.16.1', '2030.01.16.1']);
  assert.strictEqual(RL.adoptTag(src, state, { tagged: true, version: '2030.01.16.1' }), false, 'ya lo tiene');
  assert.strictEqual(RL.adoptTag(src, state, { tagged: false, version: FLOOR }), false, 'sin etiqueta no cambia nada');
});

test('T20 Sources_Check_PendingTip_QuietWhenFresh_SaysItWhenOld', () => {
  for (const [hoursAgo, quiet] of [[0, true], [8, false]]) {
    const { pub, work } = toy();
    git(work, ['tag', 'v2030.01.16.1', 'HEAD']);
    git(work, ['push', '--quiet', 'origin', 'refs/tags/v2030.01.16.1']);
    const clone = path.join(SCRATCH, `c${serial += 1}`);
    execFileSync('git', ['clone', '--quiet', pub, clone], { env: ENV });
    // el merge siguiente, sin etiqueta, hecho hace `hoursAgo` horas
    const when = new Date(Date.now() - hoursAgo * 3600000).toISOString();
    fs.writeFileSync(path.join(work, 'b.txt'), 'b\n');
    git(work, ['add', '-A']);
    execFileSync('git', ['-C', work, 'commit', '--quiet', '-m', 'b'], { env: Object.assign({}, ENV, { GIT_COMMITTER_DATE: when, GIT_AUTHOR_DATE: when }) });
    git(work, ['push', '--quiet', 'origin', 'main']);
    const r = SRC.check({ name: 'harness', dir: clone, ref: 'main', rewrites: true }, { env: ENV, channel: 'stable', budgetS: 30 });
    if (quiet) {
      assert.strictEqual(r.status, 'up_to_date', JSON.stringify(r));
      assert.match(r.note, /todavía no tiene su número/);
    } else {
      assert.strictEqual(r.status, 'unknown', JSON.stringify(r));
      assert.match(r.reason, /sin su número .* ninguna máquina se actualiza/);
    }
  }
});

test('T21 Sources_AnnotatedTag_DoesNotNumber', () => {
  const { work } = toy();
  execFileSync('git', ['-C', work, 'tag', '-a', '-m', 'a mano', 'v2030.01.16.9', 'HEAD'], { env: ENV });
  const v = SRC.versionAt(work, 'HEAD', { env: ENV });
  assert.deepStrictEqual([v.version, Boolean(v.tagged), Boolean(v.pending)], [FLOOR, false, true], 'una anotada no numera: igual que por info/refs y la API');
});
