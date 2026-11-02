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
const { execFileSync } = require('child_process');

const SCRIPTS = path.resolve(__dirname, '..');
const GATE = path.join(SCRIPTS, '..', 'skills', 'tycon-pipeline', 'scripts', 'on-bash-write-gate.js');
const { sinGitDelPadre } = require(path.join(SCRIPTS, 'lib', 'clean-git-env.js'));

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

// Un repo de verdad: `origin/main` adelante de `main`, una rama sin constancias y otra que trae una.
function repoConRamas() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'constancias-ramas-'));
  const FECHA = '2026-01-01T00:00:00Z';
  const env = sinGitDelPadre({ GIT_AUTHOR_DATE: FECHA, GIT_COMMITTER_DATE: FECHA });
  const git = (...a) => execFileSync('git', ['-c', 'maintenance.auto=false', ...a], { cwd: repo, env, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'prueba@ejemplo.test');
  git('config', 'user.name', 'prueba');
  git('commit', '-q', '--allow-empty', '-m', 'inicio');
  git('checkout', '-q', '-b', 'sana');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
  git('add', '.');
  git('commit', '-q', '-m', 'sin constancias');
  git('update-ref', 'refs/remotes/origin/main', 'sana');
  git('checkout', '-q', '-b', 'con-firma', 'main');
  fs.mkdirSync(path.join(repo, '.tycon'));
  fs.writeFileSync(path.join(repo, '.tycon', 'control-changes.jsonl'), '{}\n');
  git('add', '.');
  git('commit', '-q', '-m', 'trae una constancia');
  git('checkout', '-q', 'main');
  return repo;
}

function correrEn(repo) {
  const gate = require(GATE);
  return (command) => gate.handle({ tool_name: 'Bash', tool_input: { command }, cwd: repo, session_id: 'prueba' }, { stateDir: path.join(repo, 'estado'), installedRoots: [] });
}

// 🔴 Falla con: una redirección leída como argumento. `2>&1` se partía en las palabras `2` y `1`, que se miraban como
// ramas y frenaban un avance legítimo; y un destino de copia seguido de una redirección dejaba de ser el destino.
test('Constancias_Redireccion_NoEsUnArgumento', () => {
  const correr = correrEn(repoConRamas());
  const pasan = [
    'git merge --ff-only origin/main',
    'git merge --ff-only origin/main 2>&1',
    'git merge --ff-only origin/main 2>&1 | tail -1',
    'git merge --ff-only origin/main > /tmp/salida.txt',
    'git merge --ff-only origin/main>/tmp/salida.txt',
    'git merge --ff-only origin/main >> /tmp/salida.txt 2>&1',
    'git merge --ff-only origin/main &> /tmp/salida.txt',
    'git merge --ff-only origin/main 2> /tmp/errores.txt',
    'git reset --hard origin/main 2>&1',
    'git rebase origin/main > /tmp/salida.txt',
    'git branch -f sana origin/main 2>&1',
  ];
  for (const c of pasan) assert.ok(!(correr(c) || {}).block, `pasa: ${c}`);
  const frenan = [
    // lo que trae la rama, con o sin redirección
    'git merge --ff-only con-firma',
    'git merge --ff-only con-firma 2>&1',
    'git merge --ff-only con-firma > /tmp/salida.txt',
    'git merge con-firma>/tmp/salida.txt',
    'git reset --hard con-firma 2>&1',
    // una rama que no se puede mirar sigue sin pasar
    'git merge no-existe 2>&1',
    // entre comillas no es una redirección: es un argumento
    "git merge con-firma '2>&1'",
    "git merge 'con-firma' '>' /tmp/salida.txt",
    "git merge --ff-only origin/main '>' /tmp/salida.txt",
    'git merge --ff-only origin/main a\\>b',
    // la redirección a una constancia, y la copia a su carpeta seguida de una redirección
    'git merge --ff-only origin/main > .tycon/control-changes.jsonl',
    'echo x 2> .tycon/control-changes.jsonl',
    'cp /tmp/x.json .github/control-changes/ 2>&1',
    'cp /tmp/x.json .github/control-changes/ > /tmp/salida.txt',
    'rsync -a /tmp/firmas/ .github/control-changes/ 2>&1',
    'install -m 644 /tmp/f .tycon/control-changes.jsonl 2>&1',
  ];
  for (const c of frenan) {
    const r = correr(c);
    assert.ok(r && r.block, `frena: ${c}`);
    assert.match(r.block, /constancia de cambio de control no se escribe a mano/, c);
  }
});

// 🔴 Falla con: el texto de un heredoc mirado como comando (frena a quien sólo escribe un archivo o un mensaje de commit
// que nombra el caso), o lo contrario: dejar de mirar lo que el shell sí corre o lo que un intérprete recibe.
test('Constancias_Heredoc_ElTextoNoEsUnComando', () => {
  const correr = correrEn(repoConRamas());
  const TEXTO = 'frenó `git merge no-existe 2>&1` y $(git merge tampoco) con `git merge con-firma`';
  const pasan = [
    `cat > /tmp/nota.txt <<'EOF'\n${TEXTO}\nEOF`,
    `cat <<'EOF' > /tmp/nota.txt\n${TEXTO}\nEOF`,
    `cat >> /tmp/nota.txt <<"EOF"\n${TEXTO}\nEOF`,
    `cat > /tmp/nota.txt <<-'EOF'\n${TEXTO}\n\tEOF`,
    `tee /tmp/nota.txt <<'EOF'\n${TEXTO}\nEOF`,
    `mkdir -p /tmp/d && cat > /tmp/d/nota.txt <<'EOF'\n${TEXTO}\nEOF`,
    `cat > /tmp/nota.txt <<'EOF'\n${TEXTO}\nEOF\ngit merge --ff-only origin/main 2>&1`,
    `git commit -m "$(cat <<'EOF'\n${TEXTO}\nEOF\n)"`,
    `git add a.txt && git commit -q -m "$(cat <<'EOF'\n${TEXTO}\nEOF\n)"`,
    `gh pr create --title t --body "$(cat <<'EOF'\n${TEXTO}\nEOF\n)"`,
  ];
  for (const c of pasan) assert.ok(!(correr(c) || {}).block, `pasa: ${c}`);
  const COPIA = '`cp /tmp/x.json .github/control-changes/`';
  const frenan = [
    // sin comillas en la marca, el shell corre lo que está adentro
    `cat > /tmp/nota.txt <<EOF\n${COPIA}\nEOF`,
    `cat > /tmp/nota.txt <<EOF\n$(printf x; cp /tmp/x.json .github/control-changes/)\nEOF`,
    `git commit -m "$(cat <<EOF\n${COPIA}\nEOF\n)"`,
    // el cuerpo es el programa de un intérprete
    `bash <<'EOF'\necho ${COPIA}\nEOF`,
    `sh -s <<'EOF'\necho ${COPIA}\nEOF`,
    `cat <<'EOF' | bash\necho ${COPIA}\nEOF`,
    `cat <<'EOF' | tee /tmp/nota.txt | sh\necho ${COPIA}\nEOF`,
    `eval "$(cat <<'EOF'\necho ${COPIA}\nEOF\n)"`,
    `bash -c "$(cat <<'EOF'\necho ${COPIA}\nEOF\n)"`,
    // el cuerpo sigue camino a un programa, afuera del heredoc o en un grupo
    `{ cat <<'EOF'\necho ${COPIA}\nEOF\n} | bash`,
    `(\ncat <<'EOF'\necho ${COPIA}\nEOF\n) | bash`,
    `if true; then cat <<'EOF'\necho ${COPIA}\nEOF\nfi | bash`,
    `tee >(bash) <<'EOF'\necho ${COPIA}\nEOF`,
    `cat() { bash; }; cat <<'EOF'\necho ${COPIA}\nEOF`,
    // un heredoc sin comillas envuelve al que parece literal: el shell corre lo de adentro
    `cat > /tmp/nota.txt <<FUERA\ncat <<'EOF'\necho ${COPIA}\nEOF\nFUERA`,
    `cat <<'A' <<FUERA\nx\nA\ncat <<'EOF'\necho ${COPIA}\nEOF\nFUERA`,
    // un comentario o un escape no abren un heredoc: lo de abajo corre
    `cat > /tmp/nota.txt # <<'EOF'\necho ${COPIA}\nEOF`,
    `cat \\<<'EOF'\necho ${COPIA}\nEOF`,
    `bash \\\ncat <<'EOF'\necho ${COPIA}\nEOF`,
    // lo que parece un mensaje pero no lo es, o que corre afuera de las comillas
    `npm run x "$(cat <<'EOF'\necho ${COPIA}\nEOF\n)"`,
    `echo 'git commit -m "$(cat <<'EOF'\necho ${COPIA}\nEOF\n)"`,
    // lo que va después del heredoc se mira
    `cat > /tmp/nota.txt <<'EOF'\ntexto\nEOF\ncp /tmp/x.json .github/control-changes/`,
    `cat > /tmp/nota.txt <<'EOF'\ntexto\nEOF\ngit merge con-firma 2>&1`,
    // una marca adentro de comillas no abre un heredoc: lo de abajo corre
    `echo '\ncat > /tmp/nota.txt <<'E''\necho ${COPIA}\nE`,
    `echo "<<'E'"\ncp /tmp/x.json .github/control-changes/\nE`,
    // un parche por heredoc sigue mirándose por lo que trae
    "git apply <<'EOF'\ndiff --git a/.tycon/control-changes.jsonl b/.tycon/control-changes.jsonl\nEOF",
  ];
  for (const c of frenan) {
    const r = correr(c);
    assert.ok(r && r.block, `frena: ${c}`);
    assert.match(r.block, /constancia de cambio de control no se escribe a mano/, c);
  }
});
