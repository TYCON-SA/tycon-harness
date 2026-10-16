#!/usr/bin/env bash
# fake-az.sh — el `az` de mentira de las suites que hablan con Azure DevOps.
#
# Nace con la story 4.4 (los pedidos de trabajo del líder) y vive en `lib/` porque la 4.5 lo reusa
# en vez de copiarlo: dos dobles del mismo CLI se separan solos, igual que dos copias de un guion.
# La suite lo elige con `TYCON_ADO_CMD`. NUNCA habla con la red.
#
# ── QUÉ HACE ─────────────────────────────────────────────────────────────────────────────────────
# · Decide qué le pidieron por los ARGUMENTOS (no por el orden de las llamadas) y contesta desde
#   fixtures en `$FIXAZ/`, con la forma medida contra Azure el 2026-09-10 y el 2026-09-13.
# · Anota CADA llamada en `$FIXAZ/llamadas.log`: `<paso>\t{"args":[…],"archivos":{ruta: contenido}}`.
#   Los archivos son los que el comando lee (`@archivo`, `Campo=@archivo`, `--in-file`), para poder
#   afirmar sobre el cuerpo de un Bug o de un comentario.
# · RECUERDA lo que crea (`$FIXAZ/creados/<id>.json`): la WIQL y `work-item show` lo devuelven igual
#   que Azure. Sin eso no se puede probar la segunda noche después de un push perdido.
#
# ── LAS TRAMPAS DE AZURE QUE REPRODUCE A PROPÓSITO ───────────────────────────────────────────────
# · Sin `--org`/`--organization` sale 1: el default de `az devops configure` apunta a un proyecto
#   que ya no existe (el de formularios), así que todo comando sin org explícita falla de verdad.
# · Sin `-o json`/`--output json` sale 1: la salida por defecto depende de la config de cada máquina.
# · Una WIQL sin `[System.TeamProject] = @project` sale 1: la ruta /{proyecto}/ NO acota (medido:
#   183 work items sin la cláusula, 0 con ella).
# · `--fields` repetido: gana el ÚLTIMO, como argparse con nargs='*'. Mandar las etiquetas en un
#   `--fields` y el texto en otro pierde las etiquetas en silencio.
#
# ── LOS DOS SABOTAJES ────────────────────────────────────────────────────────────────────────────
#   TYCON_AZ_FAIL=<paso>[:<patrón>][,…]   ese paso sale 1 (con el patrón: sólo si aparece en los
#                                          argumentos o en los archivos leídos)
#   TYCON_AZ_GARBAGE=<paso>[:<patrón>][,…]  ese paso sale 0 con texto que no es JSON
# Pasos: version identidad wiql wi revisiones estados grupo miembros equipo iteracion crear comentario actualizar prs lote
#
# ── LO QUE SUMÓ LA 2.23 (los pedidos asignados, para el sitio de la organización) ───────────────────────────────
# · `lote`: `devops invoke --area wit --resource workitemsbatch --in-file <{ids, fields}>` → `{ count, value }` con el
#   `wi-<id>.json` de cada id que tenga fixture (los que no, no vuelven: como Azure con un id borrado).
#
# ── LO QUE SUMÓ LA 4.5 (el estado de cada pedido) ────────────────────────────────────────────────
# · `revisiones`: `devops invoke --area wit --resource revisions --route-parameters id=N` → `revisiones-N.json`
#   (sin fixture sale 1 con TF401232, como el `show` de un id que no existe).
# · `estados`: `devops invoke --area wit --resource workItemTypeStates --route-parameters project=P type=Bug`
#   → `estados-P.json` (sin fixture sale 1: el tipo o el proyecto no existe).
#
# ── LO QUE SUMÓ LA 4.6 (los PR abiertos de la organización) ──────────────────────────────────────
# · `prs`: `devops invoke --area git --resource pullRequests --query-parameters … $skip=N` → `prs-N.json`
#   (sin fixture: una página vacía, `{count:0,value:[]}` — como Azure pasada la última página).
exec node - "$@" <<'JS'
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const FIX = process.env.FIXAZ;
if (!FIX) { process.stderr.write('doble-az: falta la variable FIXAZ\n'); process.exit(97); }

const tiene = (...ks) => ks.every((k) => args.includes(k));
// Como argparse con action=store: si la opción aparece dos veces, gana la ÚLTIMA.
const arg = (k) => { const i = args.lastIndexOf(k); return i < 0 ? undefined : args[i + 1]; };
const valores = (k) => {
  const i = args.lastIndexOf(k);
  if (i < 0) return [];
  const r = [];
  for (let j = i + 1; j < args.length && !args[j].startsWith('--'); j++) r.push(args[j]);
  return r;
};
const kv = (k) => Object.fromEntries(valores(k).map((s) => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)]; }));
const leerFix = (nombre) => { try { return fs.readFileSync(path.join(FIX, nombre), 'utf8'); } catch { return null; } };
const fixJson = (nombre, def) => { const t = leerFix(nombre); return t === null ? def : JSON.parse(t); };

// Los archivos que el comando leería, con la MISMA regla que `_expand_file_prefix` de az 2.79: se
// parte en el primer '=' y se lee lo que empiece con '@'. `--in-file` recibe la ruta pelada.
const archivos = {};
args.forEach((x, i) => {
  let ruta = null;
  const eq = x.indexOf('=');
  if (x.startsWith('@')) ruta = x.slice(1);
  else if (eq >= 0 && x[eq + 1] === '@') ruta = x.slice(eq + 2);
  else if (args[i - 1] === '--in-file') ruta = x;
  if (ruta) {
    try { archivos[ruta] = fs.readFileSync(ruta, 'utf8'); }
    catch (e) { archivos[ruta] = `<<no se pudo leer: ${e.message}>>`; }
  }
});

let paso = 'desconocido';
if (args[0] === '--version') paso = 'version';
else if (tiene('devops', 'invoke') && String(arg('--area')).toLowerCase() === 'ims') paso = 'identidad';
else if (tiene('devops', 'invoke') && String(arg('--area')).toLowerCase() === 'wit' && String(arg('--resource')).toLowerCase() === 'wiql') paso = 'wiql';
else if (tiene('devops', 'invoke') && String(arg('--area')).toLowerCase() === 'wit' && String(arg('--resource')).toLowerCase() === 'revisions') paso = 'revisiones';
else if (tiene('devops', 'invoke') && String(arg('--area')).toLowerCase() === 'wit' && String(arg('--resource')).toLowerCase() === 'workitemtypestates') paso = 'estados';
else if (tiene('devops', 'invoke') && String(arg('--area')).toLowerCase() === 'git' && String(arg('--resource')).toLowerCase() === 'pullrequests') paso = 'prs';
else if (tiene('devops', 'invoke') && String(arg('--area')).toLowerCase() === 'wit' && String(arg('--resource')).toLowerCase() === 'workitemsbatch') paso = 'lote';
else if (tiene('devops', 'security', 'group', 'membership', 'list')) paso = 'miembros';
else if (tiene('devops', 'security', 'group', 'list')) paso = 'grupo';
else if (tiene('devops', 'project', 'show')) paso = 'equipo';
else if (tiene('boards', 'iteration', 'team', 'list')) paso = 'iteracion';
else if (tiene('boards', 'work-item', 'show')) paso = 'wi';
else if (tiene('boards', 'work-item', 'create')) paso = 'crear';
else if (tiene('boards', 'work-item', 'update')) paso = args.includes('--discussion') ? 'comentario' : 'actualizar';

fs.appendFileSync(path.join(FIX, 'llamadas.log'), `${paso}\t${JSON.stringify({ args, archivos })}\n`);

const falla = (msg, code = 1) => { process.stderr.write(`ERROR: ${msg}\n`); process.exit(code); };
// Escritura SINCRÓNICA: `process.stdout.write` + `process.exit` corta la salida a un pipe pasados ~64 KB
// (lo destapó la 4.6: una página de 100 PR llegaba truncada y el JSON era ilegible).
const out = (o) => {
  const buf = Buffer.from(`${JSON.stringify(o, null, 2)}\n`);
  for (let off = 0; off < buf.length;) {
    try { off += fs.writeSync(1, buf, off); } catch (e) { if (e.code !== 'EAGAIN') throw e; }
  }
  process.exit(0);
};

const coincide = (spec) => String(spec || '').split(',').map((s) => s.trim()).filter(Boolean).some((s) => {
  const [p, ...resto] = s.split(':');
  if (p !== paso) return false;
  const patron = resto.join(':');
  return !patron || JSON.stringify(args).includes(patron) || Object.values(archivos).some((t) => t.includes(patron));
});
if (coincide(process.env.TYCON_AZ_FAIL)) falla(`falla fabricada en el paso ${paso}`);
if (coincide(process.env.TYCON_AZ_GARBAGE)) { process.stdout.write('esto no es JSON, es lo que devuelve un proxy caído\n'); process.exit(0); }

if (paso === 'version') { process.stdout.write('azure-cli 2.79.0 (doble de pruebas)\n'); process.exit(0); }
if (paso === 'desconocido') falla(`doble-az: comando no reconocido: ${args.join(' ')}`, 2);
if (!args.includes('--org') && !args.includes('--organization')) {
  falla('sin --org: el default de `az devops configure` apunta a un proyecto que ya no existe');
}
const salida = arg('-o') || arg('--output');
if (salida !== 'json') falla('sin -o json: la salida por defecto depende de la configuración de cada máquina');

const dirCreados = path.join(FIX, 'creados');
const creados = () => {
  try { return fs.readdirSync(dirCreados).map((f) => JSON.parse(fs.readFileSync(path.join(dirCreados, f), 'utf8'))); }
  catch { return []; }
};

switch (paso) {
  case 'identidad': {
    const mail = kv('--query-parameters').filterValue;
    out(fixJson(`identidades-${mail}.json`, { count: 0, value: [] }));
    break;
  }
  case 'wiql': {
    const proyecto = kv('--route-parameters').project;
    let cuerpo;
    try { cuerpo = JSON.parse(archivos[arg('--in-file')] || ''); } catch { falla('--in-file no es JSON'); }
    const q = String(cuerpo.query || '');
    if (!/\[System\.TeamProject\]\s*=\s*@project/i.test(q)) {
      falla('consulta sin [System.TeamProject] = @project: la ruta /{proyecto}/ NO acota (medido: 183 contra 0)');
    }
    const etiqueta = (q.match(/'(arnes:[^']+)'/) || [])[1];
    const base = fixJson(`wiql-${proyecto}.json`, { workItems: [] });
    const recordados = creados()
      .filter((c) => c.proyecto === proyecto && etiqueta && String(c.tags).includes(etiqueta))
      .map((c) => ({ id: c.id }));
    out({ queryType: 'flat', ...base, workItems: [...(base.workItems || []), ...recordados] });
    break;
  }
  case 'wi': {
    const id = arg('--id');
    const f = fixJson(`wi-${id}.json`, null);
    if (f) out(f);
    const c = creados().find((x) => String(x.id) === String(id));
    if (c) out({ id: c.id, fields: { 'System.Tags': c.tags, 'System.TeamProject': c.proyecto } });
    falla(`TF401232: el work item ${id} no existe o no tenés permiso para leerlo`);
    break;
  }
  case 'revisiones': {
    const id = kv('--route-parameters').id;
    const f = fixJson(`revisiones-${id}.json`, null);
    if (f) out(f);
    falla(`TF401232: el work item ${id} no existe o no tenés permiso para leerlo`);
    break;
  }
  case 'estados': {
    const rp = kv('--route-parameters');
    const f = fixJson(`estados-${rp.project}.json`, null);
    if (f) out(f);
    falla(`VS402323: el tipo ${rp.type} no existe en el proyecto ${rp.project}`);
    break;
  }
  case 'prs': {
    const skip = Number(kv('--query-parameters').$skip || 0);
    out(fixJson(`prs-${skip}.json`, { count: 0, value: [] }));
    break;
  }
  case 'lote': {
    // story 2.23: los campos de varios work items en un pedido (POST wit/workitemsbatch, como Azure: hasta 200 ids)
    let cuerpo;
    try { cuerpo = JSON.parse(archivos[arg('--in-file')] || ''); } catch { falla('--in-file no es JSON'); }
    if (!Array.isArray(cuerpo.ids) || cuerpo.ids.length > 200) falla('workitemsbatch: ids tiene que ser una lista de hasta 200');
    out({ count: cuerpo.ids.length, value: cuerpo.ids.map((id) => fixJson(`wi-${id}.json`, null)).filter(Boolean) });
    break;
  }
  case 'grupo': {
    const p = arg('--project');
    out(fixJson(`grupo-${p}.json`, { graphGroups: [
      { displayName: 'Contributors', descriptor: 'vssgp.contrib', principalName: `[${p}]\\Contributors`, subjectKind: 'group' },
      { displayName: 'Project Administrators', descriptor: `vssgp.${p}`, principalName: `[${p}]\\Project Administrators`, subjectKind: 'group' },
    ] }));
    break;
  }
  case 'miembros': {
    const d = arg('--id');
    out(fixJson(`miembros-${d}.json`, fixJson('miembros.json', {})));
    break;
  }
  case 'equipo': {
    const p = arg('--project');
    out(fixJson(`proyecto-${p}.json`, { name: p, defaultTeam: { name: `${p} Team` } }));
    break;
  }
  case 'iteracion': {
    if (!arg('--team')) falla('az boards iteration team list: falta --team');
    out(fixJson(`iteracion-${arg('--project')}.json`, []));
    break;
  }
  case 'crear': {
    for (const k of ['--project', '--type', '--title']) if (!arg(k)) falla(`work-item create: falta ${k}`);
    const n = Number(String(leerFix('contador') || '100').trim()) + 1;
    fs.writeFileSync(path.join(FIX, 'contador'), String(n));
    const campos = kv('--fields');
    const tags = campos['System.Tags'] || '';
    fs.mkdirSync(dirCreados, { recursive: true });
    fs.writeFileSync(path.join(dirCreados, `${n}.json`), JSON.stringify({ id: n, proyecto: arg('--project'), tags }));
    out({ id: n, fields: { 'System.Title': arg('--title'), 'System.Tags': tags, 'System.TeamProject': arg('--project') } });
    break;
  }
  case 'comentario': {
    if (!arg('--id')) falla('work-item update: falta --id');
    out({ id: Number(arg('--id')), fields: {} });
    break;
  }
  case 'actualizar': {
    // Un cierre (`--state`) contesta el estado nuevo y el motivo que Azure pone por defecto al no mandarlo
    // (medido el 2026-09-15 con validateOnly: «Fixed and verified» desde New en Agile).
    if (!arg('--id')) falla('work-item update: falta --id');
    const st = arg('--state');
    out({ id: Number(arg('--id')), fields: st ? { 'System.State': st, 'System.Reason': String(leerFix(`motivo-${arg('--id')}`) || 'Fixed and verified').trim() } : {} });
    break;
  }
  default: falla(`doble-az: paso sin respuesta: ${paso}`, 2);
}
JS
