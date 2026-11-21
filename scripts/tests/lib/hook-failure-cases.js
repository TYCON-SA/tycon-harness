'use strict';
// Los casos de la matriz de fallas para cada camino que hoy frena al fallar (historia 8.159): `CASOS[guion][camino]` arma
// la falla en el laboratorio (hook-failure-lab.js) y corre el freno; devuelve una corrida o una lista de corridas, y cada
// una tiene que frenar. Las recetas salen de leer cada freno: qué archivo de estado poner ilegible, qué biblioteca sacar.
// El freno de publicación tiene los suyos en hook-failure-matrix.test.js.
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./hook-failure-lab.js');

const P = (rel) => path.join(ROOT, rel);
const PRE_COMMIT = P('skills/tycon-pipeline/scripts/on-pre-commit.js');
const BASH_WRITE = P('skills/tycon-pipeline/scripts/on-bash-write-gate.js');
const STOP_DOD = P('skills/tycon-pipeline/scripts/on-stop-dod-gate.js');
const RETRO = P('scripts/hooks/retro-pending.js');
const UNPUSHED = P('scripts/hooks/unpushed-work-notice.js');
const SESSION_CAP = P('scripts/hooks/session-cap-guard.js');
const AUTO_COMPLETE = P('scripts/hooks/pr-auto-complete-guard.js');
const SAFETY = P('scripts/hooks/safety-guard-pre.sh');
const PROD = P('scripts/hooks/prod-access-guard.js');

const SID = 's1';
const bash = (command, cwd, extra = {}) => JSON.stringify({ hook_event_name: 'PreToolUse', session_id: SID, tool_name: 'Bash', cwd, tool_input: { command }, ...extra });
const stop = (extra = {}) => JSON.stringify({ hook_event_name: 'Stop', session_id: SID, stop_hook_active: false, ...extra });
// la corrida abierta de la sesión: su marcador en la carpeta de estado
const marcador = (L, contenido = { storyId: '9.99', sessionId: SID }) => fs.writeFileSync(path.join(L.estado, 'active', `${SID}.json`), typeof contenido === 'string' ? contenido : JSON.stringify(contenido));
// el registro de aperturas que no se puede leer: una carpeta en su lugar (EISDIR)
const registroIlegible = (L) => fs.mkdirSync(path.join(L.estado, 'gates.log'), { recursive: true });

const CASOS = {
  'on-pre-commit.js': {
    'freno-de-guardar-caido-en-corrida': (L) => {
      const r = L.repo();
      marcador(L);
      return L.correr(PRE_COMMIT, bash('git commit -m x', r.dir), { extra: L.sinModulo('save-brake\\.js$'), cwd: r.dir });
    },
    'corrida-con-registro-ilegible': (L) => {
      const r = L.repo();
      marcador(L);
      registroIlegible(L);
      return L.correr(PRE_COMMIT, bash('git commit -m x', r.dir), { cwd: r.dir });
    },
    'marcador-de-corrida-ilegible-hacia-el-equipo': (L) => {
      const r = L.repo();
      marcador(L, '{{{');
      return L.correr(PRE_COMMIT, bash('git push origin main', r.dir), { cwd: r.dir });
    },
  },
  'pr-auto-complete-guard.js': {
    'lector-de-merge-no-carga': (L) => L.correr(AUTO_COMPLETE, bash('gh pr merge 5 --merge', L.dir), { extra: L.sinModulo('gh-pr\\.js$') }),
  },
  'session-cap-guard.js': {
    'entrada-ilegible-con-claude': (L) => L.correr(SESSION_CAP, 'claude --bg x'),
    'no-pude-decidir': (L) => L.correr(SESSION_CAP, bash('claude --bg x', L.dir), { extra: L.sinModulo('shell-parse\\.js$') }),
    'no-pude-contar': (L) => {
      fs.mkdirSync(path.join(L.estado, 'coordination'), { recursive: true });
      fs.writeFileSync(path.join(L.estado, 'coordination', 'opened.json'), '{roto');
      return L.correr(SESSION_CAP, bash('claude --bg x', L.dir));
    },
    'no-pude-anotar': (L) => {
      const coord = path.join(L.estado, 'coordination');
      fs.mkdirSync(coord, { recursive: true });
      fs.chmodSync(coord, 0o555);
      return L.correr(SESSION_CAP, bash('claude --bg x', L.dir));
    },
  },
  'on-bash-write-gate.js': {
    'red-del-freno-caido-escribe-historia': (L) => [
      L.correr(BASH_WRITE, bash('rm specs/a.md', L.dir), { guion: L.solo(BASH_WRITE) }),
      L.correr(BASH_WRITE, '{{{ rm specs/a.md', { guion: L.solo(BASH_WRITE) }),
    ],
    'ejecucion-perdida-sin-poder-revisar': (L) => {
      marcador(L);
      registroIlegible(L);
      return L.correr(BASH_WRITE, bash('touch x', L.dir));
    },
    'borra-carpeta-sin-leer-aperturas': (L) => {
      registroIlegible(L);
      const carpeta = path.join(L.dir, 'algo');
      fs.mkdirSync(carpeta);
      return L.correr(BASH_WRITE, bash(`rm -rf ${carpeta}`, L.dir));
    },
    'historia-ilegible-cuenta-como-historia': (L) => {
      const r = L.repo();
      fs.mkdirSync(path.join(r.dir, 'specs'), { recursive: true });
      const h = path.join(r.dir, 'specs', 'story-9.99-x.md');
      fs.writeFileSync(h, '---\nstory: 9.99\nstatus: draft\n---\n# x\n');
      fs.chmodSync(h, 0o000);
      return L.correr(BASH_WRITE, bash('echo x >> specs/story-9.99-x.md', r.dir), { cwd: r.dir });
    },
  },
  'on-stop-dod-gate.js': {
    'lista-de-corridas-ilegible-retiene': (L) => {
      marcador(L);
      registroIlegible(L);
      return L.correr(STOP_DOD, JSON.stringify({ session_id: SID }));
    },
    'no-pude-revisar-las-piezas-retiene': (L) => L.correr(STOP_DOD, JSON.stringify({ session_id: SID, cwd: 123 })),
    'contador-de-frenos-ilegible-retiene': (L) => {
      marcador(L);
      registroIlegible(L);
      fs.mkdirSync(path.join(L.estado, 'lost-run-stop', `${SID}.json`), { recursive: true });
      // sin poder contar, retiene también el segundo cierre
      return [L.correr(STOP_DOD, JSON.stringify({ session_id: SID })), L.correr(STOP_DOD, JSON.stringify({ session_id: SID }))];
    },
  },
  'retro-pending.js': {
    'fecha-de-entrada-ajena-ilegible-reclama': (L) => {
      const r = L.repo();
      const sha = r.git('rev-parse', 'HEAD').stdout.trim();
      fs.writeFileSync(path.join(L.estado, 'retro-pending.jsonl'), `${JSON.stringify({ ts: 'no-es-fecha', sessionId: 'otra', repoPath: r.dir, sha, branch: 'main' })}\n`);
      return L.correr(RETRO, stop({ cwd: r.dir }), { cwd: r.dir, extra: { TYCON_RETRO_ASK_PR: '0' } });
    },
    'carpeta-no-es-repo-se-reclama': (L) => {
      const dir = path.join(L.dir, 'no-es-repo');
      fs.mkdirSync(dir);
      // stable-data: el merge propio tiene que ser reciente para que el freno lo reclame; la hora no se compara
      fs.writeFileSync(path.join(L.estado, 'retro-pending.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), sessionId: SID, repoPath: dir, sha: 'a'.repeat(40), branch: 'main' })}\n`);
      return L.correr(RETRO, stop({ cwd: dir }), { cwd: dir, extra: { TYCON_RETRO_ASK_PR: '0' } });
    },
    'contador-de-bloqueos-ilegible-frena-sin-tope': (L) => {
      const dir = path.join(L.dir, 'no-es-repo');
      fs.mkdirSync(dir);
      // stable-data: el merge propio tiene que ser reciente para que el freno lo reclame; la hora no se compara
      fs.writeFileSync(path.join(L.estado, 'retro-pending.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), sessionId: SID, repoPath: dir, sha: 'a'.repeat(40), branch: 'main' })}\n`);
      fs.mkdirSync(path.join(L.estado, `retro-gate-${SID}.count`));
      // pasa el tope de tres bloqueos seguidos: sin contador, retiene igual
      return [1, 2, 3, 4].map(() => L.correr(RETRO, stop({ cwd: dir }), { cwd: dir, extra: { TYCON_RETRO_ASK_PR: '0' } }));
    },
  },
  'unpushed-work-notice.js': {
    'repo-no-escaneado-retiene': (L) => {
      const dir = path.join(L.dir, 'no-es-repo');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(L.estado, `unpushed-commits-${SID}.jsonl`), `${JSON.stringify({ kind: 'commit', repo: dir, sha: 'a'.repeat(40) })}\n`);
      return [L.correr(UNPUSHED, stop()), L.correr(UNPUSHED, stop())];
    },
    'estado-de-avisados-no-anotable-retiene': (L) => {
      // trabajo sin subir de verdad: un remoto al día con el primer commit, y un commit local después
      const r = L.repo();
      const remoto = path.join(L.dir, 'remoto.git');
      require('child_process').spawnSync('git', ['init', '-q', '--bare', remoto]);
      r.git('remote', 'add', 'origin', remoto);
      r.git('push', '-q', '-u', 'origin', 'main');
      fs.writeFileSync(path.join(r.dir, 'b.txt'), 'b\n');
      r.git('add', 'b.txt');
      r.git('commit', '-q', '-m', 'sin subir');
      const sha = r.git('rev-parse', 'HEAD').stdout.trim();
      fs.writeFileSync(path.join(L.estado, `unpushed-commits-${SID}.jsonl`), `${JSON.stringify({ kind: 'commit', repo: r.dir, sha })}\n`);
      fs.mkdirSync(path.join(L.estado, 'unpushed-notice.json'));
      return [L.correr(UNPUSHED, stop()), L.correr(UNPUSHED, stop())];
    },
    'carpeta-borrada-sin-poder-mirarla': (L) => {
      fs.writeFileSync(path.join(L.estado, `unpushed-commits-${SID}.jsonl`), `${JSON.stringify({ kind: 'commit', repo: path.join(L.dir, 'ya-no-esta') })}\n`);
      return L.correr(UNPUSHED, stop());
    },
  },
  'safety-guard-pre.sh': {
    'entrada-vacia': (L) => L.correr(SAFETY, ''),
    'entrada-no-json': (L) => [L.correr(SAFETY, 'hola'), L.correr(SAFETY, '[]')],
    'without-jq-or-node': (L) => L.correr(SAFETY, bash('ls', L.dir), { PATH: L.pathSin(['jq', 'node']) }),
    'reloj-vencido': (L) => L.correr(SAFETY, '', { argv: ['/bin/bash', '-c', `(sleep 4) | bash "${SAFETY}"`], extra: { TYCON_SAFETY_TIMEOUT_S: '1' } }),
  },
  'prod-access-guard.js': {
    'json-ilegible-con-base': (L) => L.correr(PROD, 'sqlcmd -S prod.example.com -Q x'),
    'sin-comando-con-base': (L) => L.correr(PROD, JSON.stringify({ x: 'sqlcmd -S prod.example.com -Q x' })),
    'comando-gigante-con-base': (L) => L.correr(PROD, bash(`sqlcmd -S prod.example.com -Q "${'x'.repeat(40 * 1024)}"`, L.dir)),
  },
};

module.exports = { CASOS };
