'use strict';
// typecheck-forms.test.js — el chequeo de tipos por formulario.
//
// Lo que no se puede perder:
//   · un formulario sin tsconfig.json sale «no chequeado», nunca limpio;
//   · un tsc que termina mal sin un solo `error TS` sale «no medido», nunca «0 errores»;
//   · un paquete que tsc no encuentra sale «no medido: falta instalar X», nunca como error de tipos;
//   · antes de chequear se instalan los formularios de los que importa código (sin eso, cada paquete del otro
//     formulario que tsc no encuentra cuenta como un error falso);
//   · el modo lo decide quien llama: en aviso sale 0 y nombra cada formulario con errores; en bloqueante frena;
//   · el modo aviso sin fecha no arranca, y pasada la fecha lo dice sin frenar;
//   · la plantilla de formularios del paquete bizuit llama al guion.
// El `tsc` y el `npm` son guiones de mentira: no se instala typescript ni se baja nada.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'ci', 'typecheck-forms.js');

function fakeTsc(formDir, output, code) {
  const bin = path.join(formDir, 'node_modules', '.bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(formDir, 'tsc-out.txt'), output);
  fs.writeFileSync(path.join(formDir, 'tsc-rc.txt'), String(code));
  const tsc = path.join(bin, 'tsc');
  fs.writeFileSync(tsc, '#!/bin/sh\ncat "$PWD/tsc-out.txt"\nexit "$(cat "$PWD/tsc-rc.txt")"\n');
  fs.chmodSync(tsc, 0o755);
}

function form(repo, name, { tsconfig = true, lock = true, tsc = null, files = {} } = {}) {
  const dir = path.join(repo, name);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name }));
  if (lock) fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');
  if (tsconfig) fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{}');
  for (const [f, txt] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), txt);
  if (tsc) fakeTsc(dir, tsc.output || '', tsc.code || 0);
  return dir;
}

function lab() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'typecheck-forms-'));
  const npmLog = path.join(repo, 'npm.log');
  const npm = path.join(repo, 'fake-npm');
  fs.writeFileSync(npm, `#!/bin/sh\necho "$PWD $*" >> "${npmLog}"\nmkdir -p node_modules/.bin\n`);
  fs.chmodSync(npm, 0o755);
  return { repo, npm, npmLog };
}

function run(l, args) {
  const r = spawnSync(process.execPath, [SCRIPT, '--repo', l.repo, ...args], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { TYCON_TYPECHECK_NPM: l.npm }),
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

const WARN = ['--mode', 'warn', '--review', '2026-12-21', '--today', '2026-10-21'];

test('T2 NoTsconfig_ReportsNotChecked_NeverClean @story-1.10 @ac-2 — sin tsconfig.json sale «no chequeado»', () => {
  const l = lab();
  form(l.repo, 'sin-tipos', { tsconfig: false, tsc: { output: '', code: 0 } });
  const r = run(l, ['--forms', 'sin-tipos', ...WARN]);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /sin-tipos: SIN TSCONFIG/);
  assert.match(r.out, /no chequeado/);
  assert.doesNotMatch(r.out, /sin-tipos: LIMPIO/);
});

test('T3 TscFailsWithoutTypeErrors_NotMeasured_NeverClean @story-1.10 @ac-3 — tsc sale 2 sin `error TS`: no medido', () => {
  const l = lab();
  form(l.repo, 'roto', { tsc: { output: 'error: Cannot read file tsconfig.json\n', code: 2 } });
  const warn = run(l, ['--forms', 'roto', ...WARN]);
  assert.strictEqual(warn.code, 0, warn.out);
  assert.match(warn.out, /roto: NO MEDIDO/);
  assert.doesNotMatch(warn.out, /roto: LIMPIO/);
  assert.doesNotMatch(warn.out, /0 errores/);
  const block = run(l, ['--forms', 'roto', '--mode', 'block']);
  assert.strictEqual(block.code, 1, block.out);
});

test('T4 Mode_WarnExitsZero_BlockExitsOne @story-1.10 @ac-4 @ac-9 — el modo decide la salida; el limpio sale igual', () => {
  const l = lab();
  const errs = 'src/a.ts(1,1): error TS2304: Cannot find name \'x\'.\nsrc/a.ts(2,1): error TS7006: Parameter \'p\' implicitly has an \'any\' type.\nsrc/b.ts(3,1): error TS2339: Property \'y\' does not exist.\n';
  form(l.repo, 'con-errores', { tsc: { output: errs, code: 2 } });
  form(l.repo, 'limpio', { tsc: { output: '', code: 0 } });
  const warn = run(l, ['--forms', 'con-errores limpio', ...WARN]);
  assert.strictEqual(warn.code, 0, warn.out);
  assert.match(warn.out, /##vso\[task\.logissue type=warning\][^\n]*con-errores[^\n]*3 errores/);
  assert.match(warn.out, /limpio: LIMPIO/);
  const block = run(l, ['--forms', 'con-errores limpio', '--mode', 'block']);
  assert.strictEqual(block.code, 1, block.out);
  assert.match(block.out, /##vso\[task\.logissue type=error\][^\n]*con-errores[^\n]*3 errores/);
  assert.match(block.out, /limpio: LIMPIO/);
  const onlyClean = run(l, ['--forms', 'limpio', '--mode', 'block']);
  assert.strictEqual(onlyClean.code, 0, onlyClean.out);
});

test('T5 MissingPackage_NotMeasured_NotTypeError @story-1.10 @ac-8 — un paquete que tsc no encuentra no es error de tipos', () => {
  const l = lab();
  const out = '../shared/voice/phone.ts(19,62): error TS2307: Cannot find module \'libreria-x\' or its corresponding type declarations.\n'
    + 'src/c.ts(4,1): error TS7006: Parameter \'k\' implicitly has an \'any\' type.\n';
  form(l.repo, 'importa', { tsc: { output: out, code: 2 } });
  const r = run(l, ['--forms', 'importa', '--mode', 'block']);
  assert.match(r.out, /importa: NO MEDIDO[^\n]*falta instalar libreria-x/);
  assert.doesNotMatch(r.out, /importa: CON ERRORES/);
  assert.strictEqual(r.code, 1, r.out);
  // Un import relativo que no existe SÍ es un error de tipos: es el caso que motivó el control.
  const l2 = lab();
  form(l2.repo, 'relativo', { tsc: { output: 'src/x.ts(1,1): error TS2307: Cannot find module \'./types/modal\' or its corresponding type declarations.\n', code: 2 } });
  const r2 = run(l2, ['--forms', 'relativo', ...WARN]);
  assert.match(r2.out, /relativo: CON ERRORES \(1\)/);
});

test('T6 WarnMode_PastReviewDate_SaysSoWithoutBlocking @story-1.10 @ac-4 @ac-10 — fecha vencida avisa; sin fecha no arranca', () => {
  const l = lab();
  form(l.repo, 'limpio', { tsc: { output: '', code: 0 } });
  const late = run(l, ['--forms', 'limpio', '--mode', 'warn', '--review', '2026-12-21', '--today', '2026-12-22']);
  assert.strictEqual(late.code, 0, late.out);
  assert.match(late.out, /##vso\[task\.logissue type=warning\][^\n]*venció la revisión del modo aviso el 2026-12-21/);
  const noDate = run(l, ['--forms', 'limpio', '--mode', 'warn']);
  assert.strictEqual(noDate.code, 2, noDate.out);
  assert.match(noDate.out, /sin fecha de revisión/);
  const badMode = run(l, ['--forms', 'limpio', '--mode', 'aviso', '--review', '2026-12-21']);
  assert.strictEqual(badMode.code, 2, badMode.out);
});

test('T7 ImportedForm_InstalledBeforeCheck @story-1.10 @ac-8 — se instala el formulario importado antes de chequear', () => {
  const l = lab();
  form(l.repo, 'A', { tsc: { output: '', code: 0 }, files: {} });
  fs.writeFileSync(path.join(l.repo, 'A', 'src', 'index.ts'), "import { x } from '../../B/src/x';\nexport const y = x;\n");
  form(l.repo, 'B');
  fs.writeFileSync(path.join(l.repo, 'B', 'src', 'x.ts'), 'export const x = 1;\n');
  const r = run(l, ['--forms', 'A', ...WARN]);
  assert.strictEqual(r.code, 0, r.out);
  const log = fs.existsSync(l.npmLog) ? fs.readFileSync(l.npmLog, 'utf8') : '';
  assert.match(log, new RegExp(`${path.join(l.repo, 'B').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} ci`));
  assert.doesNotMatch(log, /\/A ci/);
  assert.match(r.out, /A: LIMPIO/);
});

test('T9 SolutionTsconfig_ChecksReferences_NeverFalseClean @story-1.10 @ac-1 @ac-3 — un tsconfig de solución chequea sus referencias', () => {
  // El tsconfig que genera la plantilla de Vite: `files: []` y `references`. `tsc -p .` no compila nada y sale 0.
  const l = lab();
  const dir = form(l.repo, 'vite', { tsconfig: false, tsc: { output: '', code: 0 } });
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{\n  // de solución\n  "files": [],\n  "references": [{ "path": "./tsconfig.app.json" }, { "path": "./tsconfig.node.json" }],\n}\n');
  fs.writeFileSync(path.join(dir, 'tsconfig.app.json'), '{ "include": ["src"] }');
  fs.writeFileSync(path.join(dir, 'tsconfig.node.json'), '{ "include": ["vite.config.ts"] }');
  fs.writeFileSync(path.join(dir, 'node_modules', '.bin', 'tsc'), '#!/bin/sh\necho "$*" >> "$PWD/tsc-args.txt"\ncase "$*" in\n  *tsconfig.app.json*) echo "src/a.ts(1,7): error TS2322: Type \'string\' is not assignable to type \'number\'."; exit 2 ;;\n  *) exit 0 ;;\nesac\n');
  const r = run(l, ['--forms', 'vite', '--mode', 'block']);
  assert.match(r.out, /vite: CON ERRORES \(1\)/);
  assert.strictEqual(r.code, 1, r.out);
  const calls = fs.readFileSync(path.join(dir, 'tsc-args.txt'), 'utf8');
  assert.match(calls, /tsconfig\.app\.json/);
  assert.match(calls, /tsconfig\.node\.json/);
});

test('T10 PathAlias_MissingModule_IsTypeError @story-1.10 @ac-8 — un alias que no resuelve es error, no paquete sin instalar', () => {
  const l = lab();
  const out = "src/a.ts(1,1): error TS2307: Cannot find module '@/nope' or its corresponding type declarations.\n"
    + "src/a.ts(2,1): error TS2307: Cannot find module '~/otro' or its corresponding type declarations.\n";
  const dir = form(l.repo, 'alias', { tsc: { output: out, code: 2 } });
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"], "~/*": ["src/*"] } } }');
  const r = run(l, ['--forms', 'alias', ...WARN]);
  assert.match(r.out, /alias: CON ERRORES \(2\)/);
  assert.doesNotMatch(r.out, /falta instalar/);
  // Un alias declarado en `paths` que parece un paquete tampoco se manda a instalar.
  const l2 = lab();
  const dir2 = form(l2.repo, 'alias2', { tsc: { output: "src/a.ts(1,1): error TS2307: Cannot find module 'app/nope' or its corresponding type declarations.\n", code: 2 } });
  fs.writeFileSync(path.join(dir2, 'tsconfig.json'), '{ "compilerOptions": { "paths": { "app/*": ["src/*"] } } }');
  assert.match(run(l2, ['--forms', 'alias2', ...WARN]).out, /alias2: CON ERRORES \(1\)/);
  // Un paquete con alcance sigue siendo un paquete sin instalar.
  const l3 = lab();
  form(l3.repo, 'scoped', { tsc: { output: "src/a.ts(1,1): error TS2307: Cannot find module '@acme/voice-ui' or its corresponding type declarations.\n", code: 2 } });
  assert.match(run(l3, ['--forms', 'scoped', ...WARN]).out, /scoped: NO MEDIDO[^\n]*falta instalar @acme\/voice-ui/);
});

test('T11 UnreadableTsconfig_NotMeasured_BomIsRead @story-1.10 @ac-3 — un tsconfig ilegible no sale limpio; uno con BOM se lee', () => {
  // tsc acepta un tsconfig con BOM; JSON.parse no. Sin quitarlo, un tsconfig de solución se leía como «sin referencias».
  const l = lab();
  const dir = form(l.repo, 'bom', { tsconfig: false, tsc: { output: '', code: 0 } });
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), '﻿{ "files": [], "references": [{ "path": "./tsconfig.app.json" }] }');
  fs.writeFileSync(path.join(dir, 'tsconfig.app.json'), '{ "include": ["src"] }');
  fs.writeFileSync(path.join(dir, 'node_modules', '.bin', 'tsc'), '#!/bin/sh\ncase "$*" in\n  *tsconfig.app.json*) echo "src/a.ts(1,7): error TS2322: Type \'string\' is not assignable to type \'number\'."; exit 2 ;;\n  *) exit 0 ;;\nesac\n');
  assert.match(run(l, ['--forms', 'bom', '--mode', 'block']).out, /bom: CON ERRORES \(1\)/);
  const l2 = lab();
  const dir2 = form(l2.repo, 'roto', { tsconfig: false, tsc: { output: '', code: 0 } });
  fs.writeFileSync(path.join(dir2, 'tsconfig.json'), '{ "files": [], "references": [ { "path": ');
  const r = run(l2, ['--forms', 'roto', '--mode', 'block']);
  assert.match(r.out, /roto: NO MEDIDO[^\n]*tsconfig\.json ilegible/);
  assert.strictEqual(r.code, 1, r.out);
});

test('T12 InstallFails_NotMeasured_WithCauseAndAzureWarning @story-1.10 @ac-8 — la instalación que falla deja su causa', () => {
  const l = lab();
  fs.writeFileSync(l.npm, '#!/bin/sh\necho "npm ERR! code E404 paquete-que-no-existe" >&2\nexit 1\n');
  form(l.repo, 'A', { tsc: { output: '', code: 0 } });
  fs.writeFileSync(path.join(l.repo, 'A', 'src', 'index.ts'), "import { x } from '../../B/src/x';\nexport const y = x;\n");
  form(l.repo, 'B');
  fs.writeFileSync(path.join(l.repo, 'B', 'src', 'x.ts'), 'export const x = 1;\n');
  const r = run(l, ['--forms', 'A', ...WARN]);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /##vso\[task\.logissue type=warning\][^\n]*B[^\n]*E404/);
  assert.match(r.out, /A: NO MEDIDO[^\n]*falló la instalación/);
});

test('T13 MissingArgsOrTools_UsageErrorOrNotMeasured @story-1.10 @ac-3 @ac-10 — sin argumentos o sin herramientas, nunca limpio', () => {
  const l = lab();
  const sinArgs = spawnSync(process.execPath, [SCRIPT, '--mode', 'block'], { encoding: 'utf8' });
  assert.strictEqual(sinArgs.status, 2, sinArgs.stdout);
  assert.strictEqual(run(l, ['--forms', '   ', '--mode', 'block']).code, 2);
  form(l.repo, 'sin-deps');
  const dir = form(l.repo, 'sin-ts');
  fs.mkdirSync(path.join(dir, 'node_modules'));
  const r = run(l, ['--forms', 'sin-deps sin-ts', '--mode', 'block']);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /sin-deps: NO MEDIDO[^\n]*sin node_modules/);
  assert.match(r.out, /sin-ts: NO MEDIDO[^\n]*typescript no está/);
});

test('T8 ParityTrait_RequiredTypecheck_NoneIsRedUnlessDeclared @story-1.10 @ac-5 — la paridad exige el paso', () => {
  // El rasgo es el de la lista de operaciones: si su patrón no reconoce el paso tal como lo escribe la plantilla, la
  // paridad daría «nadie lo tiene» con los nueve productos al día.
  const trait = { id: 'typecheck', que: 'chequeo de tipos', patron: 'arnes-ci/typecheck-forms\\.js', grupos: ['frontend'], exigido: true, criterio: 'scripts/ci/typecheck-forms.js' };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'typecheck-parity-'));
  const step = 'steps:\n  - script: |\n      TC="$(Agent.TempDirectory)/arnes-ci/typecheck-forms.js"\n      node "$TC" --repo . --forms "x" --mode "$(typecheckMode)" --review "$(typecheckReview)"\n';
  const write = (name, text) => { fs.mkdirSync(path.join(root, name)); fs.writeFileSync(path.join(root, name, 'azure-pipelines.yml'), text); };
  write('con', step);
  write('sin', 'steps:\n  - script: echo hola\n');
  write('otro-sin', 'steps:\n  - script: echo chau\n');
  const parity = (repos, declared) => {
    const cfg = path.join(root, `cfg-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(cfg, JSON.stringify({ raiz_por_defecto: root, grupos: { frontend: repos.map((r) => ({ producto: r, ruta: r })) }, rasgos: [trait], diferencias_declaradas: declared }));
    return spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'ci', 'check-product-parity.js'), '--config', cfg], { encoding: 'utf8' }).status;
  };
  const declared = [{ grupo: 'frontend', rasgo: 'typecheck', fecha: '2026-10-21', revision: '2099-12-21', motivo: 'pedidos por producto abiertos' }];
  assert.strictEqual(parity(['con', 'sin'], []), 1, 'uno sí y otro no: divergencia');
  assert.strictEqual(parity(['sin', 'otro-sin'], []), 1, 'ninguno lo hace y es exigido: rojo, no «coinciden»');
  assert.strictEqual(parity(['sin', 'otro-sin'], declared), 0, 'ninguno lo hace pero está declarado con fecha: pasa');
});

test('T1 Template_FormsCi_RunsTypecheck @story-1.10 @ac-1 @ac-6 — la plantilla de formularios llama al guion', (t) => {
  const packs = process.env.TYCON_PACKS_DIR || path.join(ROOT, 'packs');
  const tpl = path.join(packs, 'bizuit', 'templates', 'pipelines', 'forms-ci.yml');
  if (!fs.existsSync(tpl)) {
    t.skip('NO MEDIDO: sin el paquete bizuit (viaja con el perfil del equipo); se mide con TYCON_PACKS_DIR apuntando al repo del perfil');
    return;
  }
  const y = fs.readFileSync(tpl, 'utf8');
  const stage = y.indexOf('- stage: Pruebas');
  const next = y.indexOf('- stage:', stage + 1);
  assert.ok(stage !== -1, 'la plantilla no tiene la etapa Pruebas');
  const pruebas = y.slice(stage, next === -1 ? undefined : next);
  const call = pruebas.indexOf('typecheck-forms.js');
  assert.ok(call !== -1, 'la etapa Pruebas no llama a typecheck-forms.js');
  const verdict = pruebas.indexOf("displayName: 'Verdict (0 tests");
  assert.ok(verdict === -1 || call < verdict, 'el chequeo de tipos tiene que ir antes del veredicto');
  const end = pruebas.indexOf('- task:', call);
  const step = pruebas.slice(pruebas.lastIndexOf('- task:', call), end === -1 ? undefined : end);
  assert.match(step, /DetectForms\.formsToTest/);
  assert.match(step, /--mode/);
  assert.match(step, /--review/);
  assert.match(y, /typecheckMode:|name: typecheckMode/);
  assert.match(y, /typecheckReview/);
});
