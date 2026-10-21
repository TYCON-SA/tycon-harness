#!/usr/bin/env node
/**
 * Prueba de scripts/ci/pipeline-debt.json — el registro de deuda de los pipelines.
 *
 * Por qué existe: los planes del rollout nombraban deudas (`TOTORA-E2E-1`, `URUTAU-INTEGRATION-208-1`)
 * que no vivían en ningún archivo. Un nombre en un plan es un comentario. Acá viven, y este test es
 * su lector: sin lector, el registro es un JSON que nadie mira (regla de la casa: un control que hay
 * que acordarse de invocar no corre). Precedente: scripts/controls-bench/hook-debt.json.
 *
 * Falla si: el archivo no se puede leer; una entrada no tiene id/repo/que/motivo/fecha/revision;
 * hay ids repetidos; o una `revision` YA VENCIÓ — "decidir o re-fechar". Una deuda sin vencimiento
 * es permanente, y una permanente no es una deuda: es el estado del sistema.
 */
const fs = require('fs');
const path = require('path');
// `--root <carpeta>`: el árbol que se mira (por defecto, éste). Lo usa el control del final, con dos árboles de juguete.
const iRoot = process.argv.indexOf('--root');
const ROOT = iRoot >= 0 ? path.resolve(process.argv[iRoot + 1]) : path.join(__dirname, '..', '..');
const ARCHIVO = path.join(ROOT, 'scripts', 'ci', 'pipeline-debt.json');
// La copia pública es el árbol sin el perfil del equipo, que no viaja. «Es la copia» lo dice eso, no una carpeta que falta.
const PUBLIC_COPY = !fs.existsSync(path.join(ROOT, 'perfil-equipo.json'));
let fallos = 0;
const ok = (m) => console.log(`✅ deuda: ${m}`);
const no = (m) => { console.log(`❌ deuda: ${m}`); fallos++; };

let datos;
try {
  datos = JSON.parse(fs.readFileSync(ARCHIVO, 'utf8'));
  ok('el registro se puede leer y parsear');
} catch (e) {
  no(`🔴 no se puede leer ${ARCHIVO}: ${e.message} — ilegible no es "sin deuda"`);
  process.exit(1);
}

const lista = datos.debt;
if (!Array.isArray(lista)) { no('🔴 falta la clave "debt" o no es una lista'); process.exit(1); }
ok(`${lista.length} deuda(s) declarada(s)`);

const CAMPOS = ['id', 'repo', 'que', 'motivo', 'fecha', 'revision'];
const vistos = new Set();
const hoy = new Date().toISOString().slice(0, 10);

for (const d of lista) {
  const id = d.id || '(sin id)';
  const faltan = CAMPOS.filter((c) => !d[c] || String(d[c]).trim() === '');
  if (faltan.length) no(`🔴 ${id}: le falta ${faltan.join(', ')} — una deuda sin motivo es un permiso`);
  if (vistos.has(id)) no(`🔴 ${id}: id repetido`);
  vistos.add(id);
  for (const campo of ['fecha', 'revision']) {
    if (d[campo] && !/^\d{4}-\d{2}-\d{2}$/.test(d[campo])) no(`🔴 ${id}: ${campo}="${d[campo]}" no es una fecha AAAA-MM-DD`);
  }
  if (d.revision && /^\d{4}-\d{2}-\d{2}$/.test(d.revision) && d.revision < hoy) {
    no(`🔴 ${id}: VENCIDA el ${d.revision} — decidir o re-fechar (repo: ${d.repo})`);
  }
}
if (fallos === 0) ok('todas tienen motivo, fecha y una revisión que todavía no venció');

// Una deuda saldada por una story sale del registro y su seguimiento queda cerrado. Sin
// esto, el registro sólo mira fechas: la entrada de una deuda ya pagada seguiría dando verde hasta vencer.
const SALDADAS = [
  { id: 'PIPELINE-UI-SIGNAL-FRONTEND', story: '7.18',
    seguimiento: { archivo: 'specs/story-7.6-los-repos-de-producto-adoptan-reglas-para-revisores.md', clave: 'HARNESS-UI-SIGNAL-FRONTEND' } },
];
for (const s of SALDADAS) {
  if (vistos.has(s.id)) no(`🔴 ${s.id}: la saldó la story ${s.story} y sigue en el registro`);
  else ok(`${s.id}: saldada por la story ${s.story}, fuera del registro`);
  const ruta = path.join(ROOT, s.seguimiento.archivo);
  // El seguimiento vive en una story, y las stories no viajan en la copia pública: ahí no hay dónde mirarlo, y se dice
// para que la validación de un pedido del público no lo lea como un rojo nuevo en cada corrida. En el repo
  // del equipo que falte el seguimiento —o la carpeta entera de stories— sigue siendo rojo.
  if (PUBLIC_COPY && !fs.existsSync(path.dirname(ruta))) {
    console.log(`⏭ deuda: ${s.seguimiento.clave}: NO MEDIDO — esta copia no trae ${path.dirname(s.seguimiento.archivo)}/ (las stories no viajan). No es un verde.`);
    continue;
  }
  let linea = null;
  try { linea = fs.readFileSync(ruta, 'utf8').split('\n').find((l) => l.includes(s.seguimiento.clave)); } catch { /* abajo */ }
  if (!linea) no(`🔴 ${s.id}: no encuentro el seguimiento ${s.seguimiento.clave} en ${s.seguimiento.archivo}`);
  else if (!/^- \[x\]/.test(linea) || !linea.includes(s.story)) no(`🔴 ${s.id}: el seguimiento ${s.seguimiento.clave} no está cerrado ([x]) con referencia a la ${s.story}`);
  else ok(`${s.seguimiento.clave}: cerrado con referencia a la ${s.story}`);
}

// El control del «no medido»: sólo la copia pública se saltea el
// seguimiento. Dos árboles de juguete con el registro y sin stories: con el perfil del equipo tiene que dar rojo; sin él,
// no medido. Si la copia se reconociera por la carpeta que falta, un repo del equipo que perdiera sus stories daría verde.
if (iRoot < 0) {
  const os = require('os');
  const { spawnSync } = require('child_process');
  const lab = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-debt-'));
  const env = Object.assign({}, process.env);
  delete env.NODE_TEST_CONTEXT;
  try {
    for (const [nombre, conPerfil] of [['el repo del equipo', true], ['la copia pública', false]]) {
      const root = path.join(lab, conPerfil ? 'equipo' : 'copia');
      fs.mkdirSync(path.join(root, 'scripts', 'ci'), { recursive: true });
      fs.writeFileSync(path.join(root, 'scripts', 'ci', 'pipeline-debt.json'), JSON.stringify({ debt: [] }));
      if (conPerfil) fs.writeFileSync(path.join(root, 'perfil-equipo.json'), '{}');
      const r = spawnSync(process.execPath, [__filename, '--root', root], { encoding: 'utf8', env });
      const noMedido = /NO MEDIDO/.test(r.stdout || '');
      // el rojo tiene que ser ÉSE (el seguimiento que no se encuentra), no cualquier otro: un registro ilegible también sale 1
      const bien = conPerfil ? r.status === 1 && !noMedido && /no encuentro el seguimiento/.test(r.stdout || '') : r.status === 0 && noMedido;
      if (bien) ok(`sin la carpeta de stories, ${nombre} ${conPerfil ? 'da rojo' : 'dice «no medido»'}`);
      else no(`🔴 sin la carpeta de stories, ${nombre} tenía que ${conPerfil ? 'dar rojo' : 'decir «no medido» y salir 0'}: salió ${r.status}${noMedido ? ' con «no medido»' : ''}`);
    }
  } finally { fs.rmSync(lab, { recursive: true, force: true }); }
}

console.log('─────────────');
if (fallos === 0) { console.log('✅ pipeline-debt: todo verde'); process.exit(0); }
console.log(`❌ pipeline-debt: ${fallos} falla(s)`); process.exit(1);
