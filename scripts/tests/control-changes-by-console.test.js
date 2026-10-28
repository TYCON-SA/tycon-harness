'use strict';

/**
 * control-changes-by-console.test.js — una constancia de cambio de control sólo la escribe el guion de la firma
 * (`run-base-controls.sh approve`). El freno de escritura por consola (`on-bash-write-gate.js`) frena cualquier otro
 * camino que la ponga en el repo, y deja pasar mirarla, buscarla o agregarla al commit.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPTS = path.resolve(__dirname, '..');

// 🔴 Falla con: una constancia puesta por consola por otro camino que el guion (copiar a la carpeta, `git mv`,
// `install`, `rsync`, un parche, reponerla de otra rama, el índice) que el freno de escritura deja pasar; o un freno
// que también para mirarla, buscarla o agregarla al commit.
test('BaseControls_ConstanciaAMano_PorConsola', () => {
  const gate = require(path.join(SCRIPTS, '..', 'skills', 'tycon-pipeline', 'scripts', 'on-bash-write-gate.js'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'constancias-'));
  fs.writeFileSync(path.join(repo, 'firma.patch'), 'diff --git a/.github/control-changes/x.json b/.github/control-changes/x.json\n');
  fs.writeFileSync(path.join(repo, 'otro.patch'), 'diff --git a/README.md b/README.md\n');
  fs.writeFileSync(path.join(repo, 'firma.txt'), '--- a/x\n+++ b/.tycon/control-changes.jsonl\n');
  fs.writeFileSync(path.join(repo, 'octal.patch'), 'diff --git "a/.tycon/control\\055changes.jsonl" "b/.tycon/control\\055changes.jsonl"\n');
  fs.mkdirSync(path.join(repo, '.git'));
  fs.mkdirSync(path.join(repo, 'forjado', '.tycon', 'control-changes'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'forjado', '.tycon', 'control-changes', 'x.json'), '{}');
  fs.mkdirSync(path.join(repo, 'limpio', 'docs'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'limpio', 'docs', 'a.md'), 'a');
  fs.mkdirSync(path.join(repo, '.github', 'control-changes'), { recursive: true });
  fs.symlinkSync(path.join(repo, 'forjado'), path.join(repo, 'enlace'));
  const correr = (command) => gate.handle({ tool_name: 'Bash', tool_input: { command }, cwd: repo, session_id: 'prueba' }, { stateDir: path.join(repo, 'estado'), installedRoots: [] });
  const frenan = [
    'cp /tmp/x.json .github/control-changes/',
    'cp -r /tmp/firmas .github/control-changes',
    'git mv firma.json .github/control-changes/abc.json',
    'install -m 644 /tmp/f .tycon/control-changes.jsonl',
    'rsync -a /tmp/firmas/ .github/control-changes/',
    'git apply firma.patch',
    'patch -p1 < firma.patch',
    'git checkout firma -- .tycon/control-changes.jsonl',
    'git restore --source firma -- .tycon/control-changes.jsonl',
    'git update-index --add --cacheinfo 100644,abc,.tycon/control-changes.jsonl',
    // el destino que no es el último argumento, y la carpeta de arriba con las constancias adentro de lo copiado
    'cp -t .github/control-changes/ /tmp/x.json',
    'cp --target-directory=.tycon/control-changes /tmp/x.json',
    'cp -r forjado/. .',
    'cp -r forjado/.tycon .',
    'rsync -a forjado/ .',
    'mv forjado/.tycon .',
    'ln -s /tmp/x.json .github/control-changes/x.json',
    'ditto /tmp/x.json .tycon/control-changes/x.json',
    'scp host:x.json .tycon/control-changes/',
    'scp -r host:forjado/. .',
    // un parche que no se puede leer antes de aplicarlo, o que nombra la constancia de otra forma
    'git am firma.patch',
    'cat firma.patch | git apply',
    'git apply -',
    "printf 'x' > nuevo.diff && git apply nuevo.diff",
    'git apply otro.patch falta.patch',
    'patch -p1 -i firma.txt',
    'git apply octal.patch',
    "git apply <<'EOF'\ndiff --git a/.tycon/control-changes.jsonl b/.tycon/control-changes.jsonl\nEOF",
    // la copia adentro de otro comando: lo que corre adentro se mira igual
    "bash -c 'cp /tmp/x.json .github/control-changes/'",
    'eval cp /tmp/x.json .github/control-changes/',
    'echo $(cp /tmp/x.json .github/control-changes/)',
    'echo `cp /tmp/x.json .github/control-changes/`',
    '{ cp /tmp/x.json .github/control-changes/; }',
    'if true; then cp /tmp/x.json .github/control-changes/; fi',
    'timeout 5 cp /tmp/x.json .github/control-changes/',
    'xargs -I {} cp {} .github/control-changes/ < lista',
    'find /tmp -name x.json -exec cp {} .github/control-changes/ \\;',
    'git checkout firma .tycon/control-changes.jsonl',
    'git -C . checkout firma -- .tycon/control-changes.jsonl',
    'git -c a=b apply firma.patch',
    'git restore -sfirma .tycon/control-changes.jsonl',
    'sleep 1 & cp /tmp/x.json .github/control-changes/',
    'cat firma.patch | patch -p 1 README.md',
    'cp -r enlace/ .',
    // sin la raíz del repo (git no contesta), una carpeta o la de las constancias repuesta desde otra ref no pasa
    'git checkout firma -- .',
    'git restore --source firma limpio',
    'git restore --source HEAD~1 .github',
  ];
  for (const c of frenan) {
    const r = correr(c);
    assert.ok(r && r.block, `frena: ${c}`);
    assert.match(r.block, /constancia de cambio de control no se escribe a mano/, c);
  }
  const pasan = [
    'git apply otro.patch',
    'git add .github/control-changes/x.json',
    'cat .github/control-changes/x.json',
    'grep -r approve .github/control-changes',
    'cp .github/control-changes/x.json /tmp/',
    'cp -r .github/control-changes /tmp/copia',
    'cp -r limpio/. .',
    'rsync -a limpio/ docs/',
    'rsync /tmp/no-existe.txt docs/a.md',
    "git apply <<'EOF'\ndiff --git a/README.md b/README.md\nEOF",
    'bash scripts/ci/run-base-controls.sh approve --root . --out .tycon/control-changes/ --entries x',
    // un archivo suelto repuesto desde otra ref no trae una constancia, aunque git no conteste
    'git restore --source HEAD~1 src/a.ts',
    'git checkout firma -- limpio/docs/a.md',
  ];
  for (const c of pasan) assert.ok(!(correr(c) || {}).block, `pasa: ${c}`);
});
