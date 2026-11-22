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

// 🔴 Falla con: no leer `<>` como una escritura, tomar el renglón continuado de un heredoc como su cuerpo, no mirar lo
// que un heredoc le da a un shell, cortar el destino de una redirección en la comilla o en la sustitución, o no conocer
// los comandos que escriben el archivo que nombran (`sort -o`, `uniq`, `awk -i inplace`, `ex`, `touch`).
test('BaseControls_ConstanciaAMano_FormasRaras', () => {
  const gate = require(GATE);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'constancias-raras-'));
  fs.mkdirSync(path.join(repo, '.git'));
  fs.mkdirSync(path.join(repo, '.github', 'control-changes'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.tycon'));
  const correr = (command) => gate.handle({ tool_name: 'Bash', tool_input: { command }, cwd: repo, session_id: 'prueba' }, { stateDir: path.join(repo, 'estado'), installedRoots: [] });
  const F = '.tycon/control-changes.jsonl';
  const D = '.github/control-changes/x.json';
  const frenan = [
    `echo x 1<> ${F}`,
    `echo x <> ${F}`,
    `echo x 2<> ${F}`,
    `exec 3<>${F}`,
    `cd .tycon; echo x 1<> control-changes.jsonl`,
    `cat <<'EOF' \\\n> ${F}\nx\nEOF`,
    `cat <<'EOF' \\\n| tee ${F}\nx\nEOF`,
    `bash <<'EOF'\ncp /tmp/x ${D}\nEOF`,
    `cat <<'EOF' | sh\ncp /tmp/x ${D}\nEOF`,
    `cp /tmp/x .github/control-changes/ >'a'a`,
    `cp /tmp/x ${D} > $(date +%F).log`,
    `sort -o ${F} /tmp/x`,
    `sort --output=${F} /tmp/x`,
    `uniq /tmp/x ${F}`,
    `awk -i inplace '{print}' ${F}`,
    `ex -sc 'wq' ${F}`,
    `vim -c wq ${F}`,
    `touch ${F}`,
    // lo que encontró el pase adversarial
    `uniq -f 1 /tmp/x ${F}`,
    `uniq -w 3 /tmp/x ${F}`,
    `uniq - ${F} < /tmp/x`,
    `awk -iinplace '{print}' ${F}`,
    `gawk -i /usr/share/awk/inplace.awk 1 ${F}`,
    `echo x > .tycon/'control-changes.jsonl'`,
    `echo x >'.tycon'/control-changes.jsonl`,
    `echo x > .github/"control-changes"/x.json`,
    `echo x > .tycon/control\\-changes.jsonl`,
    `echo x > $(echo .tycon)/control-changes.jsonl`,
    `vim -es -c 'w ${F}' /tmp/x`,
    `ex -s +'w ${F}' /tmp/x`,
    `sed -n 'w ${F}' /tmp/x`,
    `sed -e 's/a/b/w ${F}' /tmp/x`,
    `shuf -o ${F} /tmp/x`,
    `rvim ${F}`,
    `nano ${F}`,
    `ruby -pi -e 1 ${F}`,
    // un parche por heredoc después de otro heredoc con la misma marca
    `cat <<'EOF' > /tmp/a\nx\nEOF\ngit apply <<'EOF'\ndiff --git a/${F} b/${F}\nEOF`,
    `cat <<'EOF' > /tmp/a\nx\nEOF\npatch -p1 <<'EOF'\n--- a/x\n+++ b/${F}\nEOF`,
  ];
  for (const c of frenan) {
    const r = correr(c);
    assert.ok(r && r.block, `frena: ${c}`);
    assert.match(r.block, /constancia de cambio de control no se escribe a mano/, c);
  }
  const pasan = [
    `cat ${F}`, `sort ${F}`, `sort -o /tmp/o.txt ${F}`, `uniq ${F}`, `uniq ${F} /tmp/o.txt`, `awk '{print}' ${F}`,
    `dd if=${F} of=/tmp/copia`, `echo x > /tmp/o.txt`, `cp ${D} /tmp/ > $(date +%F).log`, `touch /tmp/o.txt`,
    `uniq -f 1 ${F}`, `uniq -w 3 ${F} /tmp/o.txt`, `touch -r ${F} /tmp/o.txt`, `vim -u ${F} /tmp/x`,
    `gawk -i inplace -f ${F} /tmp/x`, `sed -n 'w /tmp/o.txt' ${F}`, `shuf ${F}`,
  ];
  for (const c of pasan) assert.ok(!(correr(c) || {}).block, `pasa: ${c}`);
});

// 🔴 Falla con: un `cd` que no se sigue (adentro de un paréntesis, `pushd`, adentro de `bash -c`), un heredoc que corre
// en el shell por `source /dev/stdin`, comillas en medio de la ruta de una copia, o los comandos que escriben el archivo
// que nombran como salida (`split`, `csplit`, `script`, `diff -o`). También frenar de más a quien sólo mira (`vim -R`).
test('BaseControls_ConstanciaAMano_CdYSalidasNombradas', () => {
  const gate = require(GATE);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'constancias-cd-'));
  fs.mkdirSync(path.join(repo, '.git'));
  fs.mkdirSync(path.join(repo, '.github', 'control-changes'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.tycon'));
  fs.mkdirSync(path.join(repo, 'sub'));
  for (const f of ['x.json', 'a', 'b']) fs.writeFileSync(path.join(repo, f), '{}\n');
  const correr = (command) => gate.handle({ tool_name: 'Bash', tool_input: { command }, cwd: repo, session_id: 'prueba' }, { stateDir: path.join(repo, 'estado'), installedRoots: [] });
  const frenan = [
    '(cd .tycon && echo x >> control-changes.jsonl)',
    '(cd .tycon && touch control-changes.jsonl)',
    '(cd .tycon; touch control-changes.jsonl)',
    '(cd .github && cp ../x.json control-changes/)',
    'pushd .tycon && touch control-changes.jsonl',
    "bash -c 'cd .tycon && touch control-changes.jsonl'",
    'cd sub && cd ../.tycon && touch control-changes.jsonl',
    'cd "$X" && touch control-changes.jsonl',
    'vim -R -c wq .tycon/control-changes.jsonl',
    "bash /dev/stdin <<'EOF'\ntouch .tycon/control-changes.jsonl\nEOF",
    // un `cd` adentro del paréntesis no hace pasar la escritura de afuera
    '(cd sub && true); echo x >> .tycon/control-changes.jsonl',
    "source /dev/stdin <<'EOF'\necho x >> .tycon/control-changes.jsonl\nEOF",
    '. /dev/stdin <<EOF\necho x >> .tycon/control-changes.jsonl\nEOF',
    "cp x.json .tycon/'control-changes.jsonl'",
    'cp x.json .github/"control-changes"/abc.json',
    'split -l 1 x.json .tycon/control-changes.jsonl',
    'split -l 1 x.json .github/control-changes/abc',
    'csplit -f .github/control-changes/abc x.json 1',
    'csplit --prefix=.github/control-changes/abc x.json 1',
    'script -q .github/control-changes/abc.json true',
    'diff -o .github/control-changes/abc.json a b',
    'diff --output=.github/control-changes/abc.json a b',
  ];
  for (const c of frenan) {
    const r = correr(c);
    assert.ok(r && r.block, `frena: ${c}`);
    assert.match(r.block, /constancia de cambio de control no se escribe a mano/, c);
  }
  const pasan = [
    'vim -R .github/control-changes/abc.json',
    'cat .github/control-changes/abc.json',
    'cat .tycon/control-changes.jsonl',
    '(cd sub && make); echo x > out.txt',
    '(cd .tycon && cat control-changes.jsonl)',
    'pushd sub && touch out.txt',
    'split -l 1 .tycon/control-changes.jsonl /tmp/parte',
    'csplit -f /tmp/parte .tycon/control-changes.jsonl 1',
    'script -q /tmp/registro.txt cat .tycon/control-changes.jsonl',
    'diff .github/control-changes/abc.json b',
    'diff -o /tmp/salida.txt .github/control-changes/abc.json b',
  ];
  for (const c of pasan) assert.ok(!(correr(c) || {}).block, `pasa: ${c}`);
});

// 🔴 Falla con: un `cd` de un paréntesis o de `bash -c` que sólo se sigue para algunos comandos (no para `sed -i`,
// `perl -pi`, `dd of=` ni `truncate`); `vim -R` que pasa con órdenes por la entrada o en modo ex; `ed -s` y `script -qc`
// leídos con el archivo como valor de una opción; `builtin cd`, `chdir` y `env -C` sin seguir; comillas en medio del
// `of=` de `dd`; o `source <(…)`, que corre en el shell lo que sale de adentro.
test('BaseControls_ConstanciaAMano_CdParaTodosYEntradaDelEditor', () => {
  const gate = require(GATE);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'constancias-cd2-'));
  fs.mkdirSync(path.join(repo, '.git'));
  fs.mkdirSync(path.join(repo, '.github', 'control-changes'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.tycon'));
  fs.mkdirSync(path.join(repo, 'sub'));
  fs.writeFileSync(path.join(repo, 'x.json'), '{}\n');
  const correr = (command) => gate.handle({ tool_name: 'Bash', tool_input: { command }, cwd: repo, session_id: 'prueba' }, { stateDir: path.join(repo, 'estado'), installedRoots: [] });
  const F = '.tycon/control-changes.jsonl';
  const frenan = [
    "(cd .tycon && sed -i '' s/a/b/ control-changes.jsonl)",
    '(cd .tycon && sed -i -e s/a/b/ control-changes.jsonl)',
    '(cd .tycon && perl -pi -e 1 control-changes.jsonl)',
    '(cd .tycon && dd of=control-changes.jsonl if=../x.json)',
    '(cd .tycon && truncate -s0 control-changes.jsonl)',
    'bash -c "cd .tycon && dd of=control-changes.jsonl"',
    `printf ':w!\\n' | vim -R ${F}`,
    `vim -R ${F} <<'EOT'\n:w!\nEOT`,
    `vim -R ${F} <<< ':w!'`,
    `vim -R ${F} < /tmp/ordenes`,
    `ex -R ${F}`,
    `vim -e -R ${F}`,
    `vim -E -R ${F}`,
    `vim -R - ${F}`,
    `ed -s ${F} <<'EOF'\nw\nEOF`,
    `ed ${F} <<'EOF'\nw\nEOF`,
    `script -qc ls ${F}`,
    'builtin cd .tycon && touch control-changes.jsonl',
    '(builtin cd .tycon && touch control-changes.jsonl)',
    'chdir .tycon && touch control-changes.jsonl',
    'env -C .tycon touch control-changes.jsonl',
    'env --chdir=.tycon touch control-changes.jsonl',
    "dd if=x.json of=.tycon/'control-changes.jsonl'",
    'source <(echo "echo x >> .tycon/control-changes.jsonl")',
    'source <(echo "touch .tycon/control-changes.jsonl")',
    '. <(printf "cp x.json .tycon/control-changes.jsonl")',
    'bash <(echo "touch .tycon/control-changes.jsonl")',
  ];
  for (const c of frenan) {
    const r = correr(c);
    assert.ok(r && r.block, `frena: ${c}`);
    assert.match(r.block, /constancia de cambio de control no se escribe a mano/, c);
  }
  const pasan = [
    `vim -R ${F}`,
    `vim -M ${F}`,
    "(cd sub && sed -i '' s/a/b/ notas.txt)",
    '(cd sub && dd of=salida.bin if=../x.json)',
    'env -C sub touch notas.txt',
    `dd if=${F} of=/tmp/copia`,
    `script -qc 'cat ${F}' /tmp/registro.txt`,
    'source <(echo "echo hola")',
  ];
  for (const c of pasan) assert.ok(!(correr(c) || {}).block, `pasa: ${c}`);
});

// 🔴 Falla con: la carpeta de `env -C` con sus comillas sin resolver; un `env` con una opción que lleva valor (`-u`), una
// variable antes de `-C` o llamado por su ruta (`/usr/bin/env`) que no se pela y deja de ver el comando; un `xargs` detrás
// de `env -C`; el comando de `script -c` sin mirar como uno más; o `vim -R -w`, que escribe las teclas en el archivo.
test('BaseControls_ConstanciaAMano_EnvScriptYVimW', () => {
  const gate = require(GATE);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'constancias-env-'));
  fs.mkdirSync(path.join(repo, '.git'));
  fs.mkdirSync(path.join(repo, '.github', 'control-changes'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.tycon'));
  fs.mkdirSync(path.join(repo, 'sub'));
  const correr = (command) => gate.handle({ tool_name: 'Bash', tool_input: { command }, cwd: repo, session_id: 'prueba' }, { stateDir: path.join(repo, 'estado'), installedRoots: [] });
  const F = '.tycon/control-changes.jsonl';
  const frenan = [
    'env -C ".tycon" touch control-changes.jsonl',
    "env -C '.tycon' touch control-changes.jsonl",
    'env --chdir=".tycon" touch control-changes.jsonl',
    'env -C ".github/control-changes" sed -i s/a/b/ x.json',
    `env -u FOO touch ${F}`,
    'env -u FOO -C .github touch control-changes/y',
    'env -C .github -u FOO touch control-changes/y',
    'env A=1 -C .tycon touch control-changes.jsonl',
    `/usr/bin/env -u FOO touch ${F}`,
    '/usr/bin/env -C .tycon touch control-changes.jsonl',
    'env -C .github/control-changes xargs touch < /tmp/l',
    `script -c "touch ${F}" /dev/null`,
    `script -qc "touch ${F}" /dev/null`,
    `script --command "touch ${F}" /dev/null`,
    `vim -R -w ${F} /tmp/x`,
    `vim -R -W ${F} /tmp/x`,
  ];
  for (const c of frenan) {
    const r = correr(c);
    assert.ok(r && r.block, `frena: ${c}`);
    assert.match(r.block, /constancia de cambio de control no se escribe a mano/, c);
  }
  const pasan = [
    'env -C "sub" touch notas.txt',
    'env -u FOO touch sub/notas.txt',
    `env -u FOO cat ${F}`,
    `script -c "cat ${F}" /dev/null`,
  ];
  for (const c of pasan) assert.ok(!(correr(c) || {}).block, `pasa: ${c}`);
});

// 🔴 Falla con: un envoltorio con valor delante de `env -C` (`timeout 5`, `nice -n 5`, `sudo -u root`, `stdbuf -o0`, una
// llave) o una opción de `env` con valor (`-P`) que no se pela; el comando de `script` entre comillas pegado a
// `--command=` o al final (la forma de macOS); `script -F`; `$PWD` y `$(pwd)` resueltos contra la carpeta de partida
// después de un `cd`; `gdd`; `diff -o` pegado; o `vim -R` con una opción que escribe un archivo (`-i`, `-V`,
// `-c:w`).
test('BaseControls_ConstanciaAMano_EnvoltoriosYPwd', () => {
  const gate = require(GATE);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'constancias-envoltorios-'));
  fs.mkdirSync(path.join(repo, '.git'));
  fs.mkdirSync(path.join(repo, '.github', 'control-changes'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.tycon'));
  fs.mkdirSync(path.join(repo, 'sub'));
  const correr = (command) => gate.handle({ tool_name: 'Bash', tool_input: { command }, cwd: repo, session_id: 'prueba' }, { stateDir: path.join(repo, 'estado'), installedRoots: [] });
  const F = '.tycon/control-changes.jsonl';
  const D = '.github/control-changes/x.json';
  const frenan = [
    'timeout 5 env -C .tycon touch control-changes.jsonl',
    'timeout -s KILL 5 env -C .tycon touch control-changes.jsonl',
    'nice -n 5 env -C .tycon touch control-changes.jsonl',
    'sudo -u root env -C .tycon touch control-changes.jsonl',
    'stdbuf -o0 env -C .tycon touch control-changes.jsonl',
    'stdbuf -o 0 env -C .tycon touch control-changes.jsonl',
    '{ env -C .tycon touch control-changes.jsonl; }',
    `env -P /bin touch ${F}`,
    `script --command='touch ${F}' /dev/null`,
    `script --command="touch ${F}" /dev/null`,
    `script --command=touch\\ ${F} /dev/null`,
    `script -q /dev/null touch ${F}`,
    `script -q /dev/null cp /tmp/x ${F}`,
    `script -F ${F}`,
    'cd .tycon && touch $PWD/control-changes.jsonl',
    'cd .tycon && touch ${PWD}/control-changes.jsonl',
    'cd .tycon && touch "$(pwd)/control-changes.jsonl"',
    `gdd if=/tmp/x of=${F}`,
    `diff -o${D} /tmp/a /tmp/b`,
    `sdiff -o${D} /tmp/a /tmp/b`,
    `vim -R -i ${F} /tmp/x`,
    `vim -R -i /tmp/viminfo ${F}`,
    `vim -R -V9${F} /tmp/x`,
    `vim -R -c:w ${F}`,
    // el separador de registro de perl (`-0`, `-0777`, `-00`) junto con `-i` en el mismo grupo de banderas
    `perl -0pi -e 1 ${D}`,
    `perl -0777pi -e 1 ${D}`,
    `perl -00pi -e 1 ${D}`,
    'cd .github/control-changes && perl -0pi -e 1 x.json',
  ];
  for (const c of frenan) {
    const r = correr(c);
    assert.ok(r && r.block, `frena: ${c}`);
    assert.match(r.block, /constancia de cambio de control no se escribe a mano/, c);
  }
  const pasan = [
    'timeout 5 env -C sub touch notas.txt',
    `sudo -u root cat ${F}`,
    `script -q /dev/null cat ${F}`,
    'cd sub && touch $PWD/notas.txt',
    `gdd if=${F} of=/tmp/copia`,
    `diff -o/tmp/salida.txt ${D} /tmp/b`,
    `vim -R ${F}`,
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
    'git merge --ff-only origin/main >| /tmp/salida.txt',
    'git merge --ff-only origin/main > "/tmp/con espacio.txt"',
    "git merge --ff-only origin/main > '/tmp/con espacio.txt'",
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
    `cat <<'EOF' > /tmp/nota.txt 2>&1\n${TEXTO}\nEOF`,
    `tee -a /tmp/nota.txt <<'EOF' > /dev/null\n${TEXTO}\nEOF`,
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
    // la línea de la marca sigue en la de abajo: lo que parece el cuerpo es parte del comando
    `cat <<'EOF' \\\n> /tmp/nota.txt\necho ${COPIA}\nEOF`,
    `cat <<'EOF' \\\n| bash\necho ${COPIA}\nEOF`,
    `tee /tmp/nota.txt <<'EOF' \\\n| sh\necho ${COPIA}\nEOF`,
    `cat <<'EOF' 'a\n' | bash\necho ${COPIA}\nEOF`,
    `cat <<'EOF' "a\n" | bash\necho ${COPIA}\nEOF`,
    `cat <<'EOF' $(\necho ${COPIA}\n)\nEOF`,
    // lo que tiene detrás la marca, en un mensaje, en un grupo o tras un comentario
    `git commit -m "$(cat <<'EOF' ; echo x\n${COPIA}\nEOF\n)"`,
    `{ git commit -m "$(cat <<'EOF'\n${COPIA}\nEOF\n)"; }`,
    `git commit -m x # "$(cat <<'EOF'\n${COPIA}\nEOF\n)"`,
    // cat redefinido de las otras dos formas
    `alias cat=bash; cat <<'EOF'\necho ${COPIA}\nEOF`,
    `function cat { bash; }; cat <<'EOF'\necho ${COPIA}\nEOF`,
    // la salida del heredoc la corre otro: una comilla invertida abierta antes, o algo detrás de la marca
    `eval \`\ncat <<'EOF'\necho $(cp /tmp/x.json .github/control-changes/)\nEOF\n\``,
    `eval \`cat <<'EOF'\necho $(cp /tmp/x.json .github/control-changes/)\nEOF\n\``,
    `cat <<'EOF' > /tmp/x && bash /tmp/x\necho ${COPIA}\nEOF`,
    `cat <<'EOF' > /tmp/x & bash /tmp/x\necho ${COPIA}\nEOF`,
    `cat <<'EOF' ; bash\necho ${COPIA}\nEOF`,
    `cat <<'EOF' <x\necho ${COPIA}\nEOF`,
    `cat <<'EOF' \`bash\`\necho ${COPIA}\nEOF`,
    `echo x | cat <<'EOF'\necho ${COPIA}\nEOF`,
    `bash <<<"${COPIA}"`,
    // un cuerpo vacío: el shell cierra en la primera marca y corre lo que sigue, hasta la otra
    `cat > /tmp/nota.txt <<'EOF'\nEOF\n${COPIA}\nEOF`,
    `tee /tmp/nota.txt <<-'EOF'\n\tEOF\n${COPIA}\nEOF`,
  ];
  for (const c of frenan) {
    const r = correr(c);
    assert.ok(r && r.block, `frena: ${c}`);
    assert.match(r.block, /constancia de cambio de control no se escribe a mano/, c);
  }
});

// 🔴 Falla con: un `>(…)` tomado por una redirección, que dejaría de mirar el comando que lleva adentro.
test('Constancias_SustitucionDeProceso_SeSigueMirando', () => {
  const correr = correrEn(repoConRamas());
  const r = correr('git merge --ff-only origin/main >(cp /tmp/x.json .github/control-changes/)');
  assert.ok(r && r.block);
  assert.match(r.block, /constancia de cambio de control no se escribe a mano/);
});

// 🔴 Falla con (lado del texto): un texto entre comillas leído como comando. El valor de una variable o de una
// descripción que CITA el guion de la firma o una redirección a la constancia frenaba sin que se escribiera nada.
test('Constancias_TextoEntreComillas_NoEsUnComando', () => {
  const correr = correrEn(repoConRamas());
  const pasan = [
    "desc='Trae main con git merge origin/main; la constancia la escribe bash scripts/ci/run-base-controls.sh approve > .tycon/control-changes.jsonl'; echo \"$desc\"",
    'desc="x > .tycon/control-changes.jsonl"',
    "echo 'cp /tmp/x.json .github/control-changes/ > .tycon/control-changes.jsonl'",
    "echo $'it\\'s > .tycon/control-changes.jsonl'",
    "printf '%s\\n' 'git checkout main -- .tycon/control-changes.jsonl' > /tmp/nota.md",
    // nombrar una variable como argumento adentro de una sustitución no la corre
    "msg='cp /tmp/x.json .github/control-changes/'; echo \"$(printf '%s' \"$msg\")\" > /tmp/nota.md",
  ];
  for (const c of pasan) {
    const r = correr(c);
    assert.ok(!(r && r.block && /constancia de cambio de control/.test(r.block)), `frenó un texto: ${c}\n${r && r.block}`);
  }
});

// 🔴 Falla con (lado del comando): un texto entre comillas que después SE CORRE —con `bash -c`, `eval`, o guardado en
// una variable que corre `eval "$c"`, `bash -c "$c"` o `$c`— pasa sin mirar. Lo que se corre es un comando.
test('Constancias_TextoQueSeCorre_SeSigueMirando', () => {
  const correr = correrEn(repoConRamas());
  const frenan = [
    "bash -c 'cp /tmp/x.json .github/control-changes/'",
    "eval 'echo hola > .tycon/control-changes.jsonl'",
    "c='cp /tmp/x.json .github/control-changes/'; eval \"$c\"",
    "c='echo hola > .tycon/control-changes.jsonl'; bash -c \"$c\"",
    "export c='cp /tmp/x.json .github/control-changes/'; sh -c \"$c\"",
    "c='cp /tmp/x.json .github/control-changes/'; $c",
    'c="git checkout firma -- .tycon/control-changes.jsonl"; eval ${c}',
    // el texto que entra a un shell o a otro programa por otro camino que `-c` (del pase adversarial)
    "echo 'echo hola > .tycon/control-changes.jsonl' | bash",
    "echo 'cp /tmp/x.json .github/control-changes/' | sh -s",
    "printf '%s' 'cp /tmp/x.json .github/control-changes/' | xargs -0 bash -c",
    "echo 'echo hola > .tycon/control-changes.jsonl' > /tmp/s.sh && bash /tmp/s.sh",
    "echo 'cp /tmp/x.json .github/control-changes/' > /tmp/s.sh; chmod +x /tmp/s.sh; /tmp/s.sh",
    "bash <<< 'cp /tmp/x.json .github/control-changes/'",
    "read c <<< 'cp /tmp/x.json .github/control-changes/'; eval \"$c\"",
    "bash -c $'cp /tmp/x.json .github/control-changes/'",
    "sh -c $'echo hola > .tycon/control-changes.jsonl'",
    "c=$'cp /tmp/x.json .github/control-changes/'; eval \"$c\"",
    "c='cp /tmp/x.json .github/control-changes/'; builtin eval \"$c\"",
    // armado acá: escrito entero, el freno instalado leería este archivo como un guion que escribe la constancia
    `node -e "require('fs').writeFileSync('${['.tycon', 'control-changes.jsonl'].join('/')}', 'x')"`,
    'echo "$(echo \'x\') > .tycon/control-changes.jsonl"; bash -c "echo hola > .tycon/control-changes.jsonl"',
  ];
  for (const c of frenan) {
    const r = correr(c);
    assert.ok(r && r.block, `pasó: ${c}`);
    assert.match(r.block, /constancia de cambio de control no se escribe a mano/, c);
  }
  // la descripción citada en la línea de `gh` frena (gh puede correr un texto), y el cartel dice cómo salir
  const desc = correr("gh pr create --title t --body 'ejemplo: echo x > .tycon/control-changes.jsonl'");
  assert.ok(desc && desc.block, 'la descripción citada en la línea de gh pasó');
  assert.match(desc.block, /--body-file/, desc.block);
});

// 🔴 Falla con: el lector de los prefijos (`A=…`, `env A=…`) que prueba todas las formas de partir un `$''` repetido y
// tarda exponencialmente: el freno se pasa de su tiempo y un freno colgado deja pasar.
test('Constancias_PrefijoConComillasRepetidas_TerminaRapido', () => {
  const correr = correrEn(repoConRamas());
  for (const cab of ['A=', 'env A=']) {
    const largo = `${cab}${"$''".repeat(30)}`;
    // stable-data: el reloj mide cuánto tarda el freno, no fecha ningún dato
    const t0 = Date.now();
    correr(largo);
    assert.ok(Date.now() - t0 < 2000, `«${cab}» con 30 «$''» tardó ${Date.now() - t0} ms`);
    // con una escritura de la constancia detrás, el prefijo largo no la esconde
    const r = correr(`${largo} cp /tmp/x.json .github/control-changes/`);
    assert.ok(r && r.block, `pasó con el prefijo «${cab}» largo`);
  }
});
