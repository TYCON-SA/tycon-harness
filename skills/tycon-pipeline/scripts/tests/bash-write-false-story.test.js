'use strict';
/**
 * bash-write-false-story.test.js — el freno de «historia escrita por consola» y los comandos que no escriben historias.
 *
 * QUÉ CUIDA: dos comandos que no tocaban ninguna historia salían frenados como «HISTORIA ESCRITA POR CONSOLA», con la
 * lista de todos los `.md` con forma de historia de la carpeta (una plantilla, unos ejemplos de prueba):
 *   1. un `node -e` que escribe un archivo cuyo nombre está en una variable del programa, cuando uno de los textos del
 *      programa dice «sed -i»: el freno leía ese texto como un comando que edita en el lugar;
 *   2. un `sed -i ''` sobre un `.sh` cuyo guion cierra la comilla simple para meter una (`'…'"'"'…'`): las palabras no
 *      se pegaban como las pega el shell, el `sed` no se reconocía como uno que nombra sus archivos y contaban todas
 *      las historias de la carpeta del `cd`.
 * Y que lo que tiene que frenar siga frenando: escribir una historia desde un programa, un programa que lanza un
 * `sed -i` sobre una historia, un `sed` que cambia el estado de una historia, un guion con una variable adentro.
 *
 * Correr: node --test skills/tycon-pipeline/scripts/tests/bash-write-false-story.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const bash = require(path.join(__dirname, '..', 'on-bash-write-gate.js'));

const SID = 'sesion-falsa-historia';
const ENV = { TYCON_LEDGER_VISIBLE: undefined, TYCON_STORY_GATE: undefined, TYCON_STORY_SKILL_GATE: undefined, TYCON_NO_RUN_CHANGE: '1' };
const HISTORIA = 'HISTORIA ESCRITA POR CONSOLA';
const Q = `'"'"'`;
// la edición en el lugar sin copia: `-i ''` en el sed de BSD (macOS), `-i` en el de GNU (en GNU `-i ''` es otra cosa)
const EN_LUGAR = process.platform === 'darwin' ? "-i ''" : '-i';

function conEnv(vars, fn) {
  const antes = {};
  for (const k of Object.keys(vars)) { antes[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(vars)) { if (antes[k] === undefined) delete process.env[k]; else process.env[k] = antes[k]; }
  }
}

const raices = [];
test.after(() => { for (const r of raices) fs.rmSync(r, { recursive: true, force: true }); });

/**
 * Una carpeta de trabajo sin historias propias, con copias de `.md` que tienen forma de historia (una plantilla y un
 * ejemplo), un guion de prueba y un `.sh`; sin ejecución abierta.
 */
function carpeta() {
  const raiz = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'falsa-historia-')));
  raices.push(raiz);
  const estado = path.join(raiz, 'estado');
  const lab = path.join(raiz, 'lab');
  for (const d of [estado, path.join(lab, 'plantillas'), path.join(lab, 'scripts', 'tests')]) fs.mkdirSync(d, { recursive: true });
  const historia = '---\nstory: "9.1"\nstatus: ready-for-dev\n---\n\n# Story 9.1\n\nCuerpo.\n';
  fs.writeFileSync(path.join(lab, 'plantillas', 'template.md'), historia);
  fs.writeFileSync(path.join(lab, 's9001.md'), historia);
  fs.writeFileSync(path.join(lab, 'scripts', 'tests', 'guard.test.sh'), 'frena "T1" "echo x"\n');
  fs.writeFileSync(path.join(lab, 'medir.sh'), 'PROG=x\ndone <<"CASOS"\n');
  return { estado, lab };
}

function juzgar(c, command) {
  return conEnv(ENV, () => bash.handle({ tool_name: 'Bash', session_id: SID, cwd: c.lab, tool_input: { command } }, { stateDir: c.estado }));
}

const frenaComoHistoria = (r) => Boolean(r && r.block && r.block.includes(HISTORIA));

// ── los dos falsos positivos ─────────────────────────────────────────────────────────────────────────────────────────

test('NodeE_DestinoEnVariable_TextoConSedI_NoEsHistoria', () => {
  const c = carpeta();
  const cmd = `cd ${c.lab} && node -e '
const fs=require("fs"); const f="scripts/tests/guard.test.sh"; let t=fs.readFileSync(f,"utf8");
const rep=(a,b)=>{ if (t.split(a).length!==2) throw new Error("no único: "+a.slice(0,50)); t=t.replace(a,()=>b); };
rep("frena \\"T21 Xargs_Cero_Frena\\" \\"echo $P/$NM | xargs -0 sed -i s/a/b/\\"\\n", "");
fs.writeFileSync(f,t); console.log("ok");'; bash -n scripts/tests/guard.test.sh && echo ok-sh`;
  const r = juzgar(c, cmd);
  assert.ok(!frenaComoHistoria(r), `el programa no escribe ninguna historia: ${r && r.block}`);
});

test('NodeE_ComillasDobles_TextoConSedI_NoEsHistoria', () => {
  const c = carpeta();
  const r = juzgar(c, `cd ${c.lab} && node -e "const f=process.argv[1]; require('fs').writeFileSync(f, 'usar sed -i para esto')" scripts/tests/guard.test.sh`);
  assert.ok(!frenaComoHistoria(r), `el texto «sed -i» es texto del programa: ${r && r.block}`);
});

test('SedEnLugar_ComillaSimpleMetida_SobreSh_NoEsHistoria', () => {
  const c = carpeta();
  const cmd = `cd ${c.lab} && sed -e 's|^PROG=.*|PROG="rm $P/$N"|' -e '/^CASOS$/,$d' medir.sh > medir-shell.sh `
    + `&& printf '%s\\n' 'bash|bash -c {}' 'sh|sh -c {}' 'CASOS' >> medir-shell.sh `
    + `&& sed ${EN_LUGAR} 's|^done <<.CASOS.$|done <<${Q}CASOS${Q}|' medir-shell.sh`;
  const r = juzgar(c, cmd);
  assert.ok(!frenaComoHistoria(r), `el sed nombra sólo medir-shell.sh: ${r && r.block}`);
});

test('SedEnLugar_ComillaSimpleMetida_ArchivoEnVariable_NoEsHistoria', () => {
  const c = carpeta();
  const r = juzgar(c, `cd ${c.lab}; f=scripts/tests/guard.test.sh; sed ${EN_LUGAR} 's/    ${Q}case "${'$'}{1:-} $\\*" in${Q},/    ${Q}case "$*" in${Q},/' $f; grep -n x $f`);
  assert.ok(!frenaComoHistoria(r), `el sed nombra sólo el guion de prueba: ${r && r.block}`);
});

// ── lo que tiene que seguir frenando ─────────────────────────────────────────────────────────────────────────────────

test('NodeE_LanzaSedISobreHistoria_Frena', () => {
  const c = carpeta();
  for (const cmd of [
    `cd ${c.lab} && node -e 'require("child_process").execSync("sed -i s/ready-for-dev/done/ s9001.md")'`,
    `cd ${c.lab} && python3 -c 'import os; os.system("sed -i s/ready-for-dev/done/ s9001.md")'`,
    `cd ${c.lab} && pwsh -Command 'sed -i s/ready-for-dev/done/ s9001.md'`,
  ]) assert.ok(frenaComoHistoria(juzgar(c, cmd)), `un programa que corre un sed -i sobre una historia frena: ${cmd}`);
});

test('NodeE_EscribeHistoria_Frena — literal, en variable del shell o con «sed -i» en el texto', () => {
  const c = carpeta();
  for (const cmd of [
    `node -e "require('fs').writeFileSync('s9001.md','x')"`,
    `F=s9001.md; node -e "require('fs').writeFileSync(process.argv[1],'x')" "$F"`,
    `cd ${c.lab} && node -e 'const f="s9001.md"; require("fs").writeFileSync(f, "sed -i")'`,
  ]) assert.ok(frenaComoHistoria(juzgar(c, cmd)), `escribir una historia desde un programa frena: ${cmd}`);
});

test('SedEnLugar_CambiaEstadoDeHistoria_Frena — también con la comilla simple metida', () => {
  const c = carpeta();
  for (const cmd of [
    `cd ${c.lab} && sed -i '' 's/ready-for-dev/done/' s9001.md`,
    `cd ${c.lab} && sed -i '' 's/^status: ready-for-dev/status: d${Q}one/' s9001.md`,
    `cd ${c.lab} && sed -i '' 's/x/y/' medir.sh; sed -i '' 's/ready-for-dev/done/' s9001.md`,
  ]) assert.ok(frenaComoHistoria(juzgar(c, cmd)), `un sed que cambia el estado de una historia frena: ${cmd}`);
});

test('SedEnLugar_GuionOArchivoQueNoSeLee_Frena — con la carpeta del cd llena de historias', () => {
  const c = carpeta();
  for (const cmd of [
    // una variable pegada al guion: no se sabe qué hace
    `X=done; cd ${c.lab} && sed -i '' 's/ready-for-dev/'"$X"'/' s9001.md`,
    // una variable pegada a otro pedazo del nombre: no se sabe dónde termina
    `s=s900; cd ${c.lab} && sed -i '' 's/a/b/' "$s"1.md`,
    // la comilla metida no esconde un `w` que escribe una historia
    `cd ${c.lab} && sed -i '' 's/a/${Q}b/w s9001.md' medir.sh`,
  ]) assert.ok(frenaComoHistoria(juzgar(c, cmd)), `frena: ${cmd}`);
});

test('Programa_QuePuedeCorrerElTexto_Frena — el pase adversarial: otro intérprete, módulos armados, salida a un shell', () => {
  const c = carpeta();
  const sed = 'sed -i \\"\\" s/ready-for-dev/done/ s9001.md';
  for (const cmd of [
    // perl y ruby corren un comando sin paréntesis
    `cd ${c.lab} && perl -e 'system "${sed}"'`,
    `cd ${c.lab} && perl -e 'exec "${sed}"'`,
    `cd ${c.lab} && ruby -e 'system "${sed}"'`,
    `cd ${c.lab} && perl -e 'open my $f, "|-", "${sed}"; close $f'`,
    // un módulo pedido con un nombre armado, o una forma de llegar a uno sin require
    `cd ${c.lab} && node -e 'const c=require("child"+"_process"); c["execSync"]("${sed}")'`,
    `cd ${c.lab} && node -e 'process.getBuiltinModule("child_process").execSync("${sed}")'`,
    `cd ${c.lab} && node -e '"".constructor.constructor("return process")().binding("spawn_sync"); "${sed}"'`,
    `cd ${c.lab} && python3 -c 'import importlib; getattr(importlib.import_module("o"+"s"),"sys"+"tem")("${sed}")'`,
    // un programa que sólo imprime, con la salida a un shell o a un guion que se corre después
    `cd ${c.lab} && node -e 'console.log("${sed}")' | sh`,
    `cd ${c.lab} && python3 -c 'print("${sed}")' | bash`,
    `cd ${c.lab} && bash <(node -e 'console.log("${sed}")')`,
    `cd ${c.lab} && node -e 'console.log("${sed}")' > x.sh && sh x.sh`,
    `cd ${c.lab} && node -e 'require("fs").writeFileSync("x.sh", "${sed}")' && sh x.sh`,
    // node con una opción que carga otro código antes del programa
    `cd ${c.lab} && node -e 'const t="${sed}"' -r ./pre.js`,
    `cd ${c.lab} && NODE_OPTIONS=--require=./pre.js node -e 'const t="${sed}"'`,
  ]) assert.ok(frenaComoHistoria(juzgar(c, cmd)), `el texto puede correr: frena: ${cmd}`);
});
