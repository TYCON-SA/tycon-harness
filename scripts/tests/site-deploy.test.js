'use strict';
// site-deploy.test.js — las instalaciones del sitio de la organización: el alta en Azure Container Apps
// en dos fases (T7 a T13, T29), los archivos de Render y de una máquina propia (T14, T36), las sondas y las variables
// previstas (T38), que ninguna organización real quede escrita (T15), y la guía y el registro (T32, T33, T42).
//
// 🔴 NINGÚN CASO TOCA AZURE. El alta habla con `az` por TYCON_AZ_CMD, que acá es scripts/tests/lib/fake-az.sh: anota
// cada orden y recuerda lo que «creó». La configuración es inventada; los secretos, marcadores sembrados en el entorno
// que ninguna salida puede traer.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const DEPLOY = path.join(ROOT, 'scripts', 'site', 'deploy');
const ACA = path.join(DEPLOY, 'azure-container-apps.js');
const FAKE_AZ = path.join(__dirname, 'lib', 'fake-az.sh');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'site-deploy-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
// el doble no es ejecutable en el repo (se corre con bash): el alta lo lanza por un envoltorio
const AZ_DOBLE = path.join(tmp, 'az');
fs.writeFileSync(AZ_DOBLE, `#!/usr/bin/env bash\nexec bash ${JSON.stringify(FAKE_AZ)} "$@"\n`, { mode: 0o755 });

// identificadores con la forma de un GUID, armados acá (no escritos enteros: un GUID suelto en un archivo es lo que T15 busca)
const guid = (c) => [8, 4, 4, 4, 12].map((n) => c.repeat(n)).join('-');
const CONFIG = () => ({
  subscription: guid('1'), resourceGroup: 'rg-sitio-acme', location: 'eastus2',
  environment: 'env-sitio-acme', app: 'sitio-acme', logAnalyticsWorkspace: 'registros-sitio-acme', logAnalyticsQuotaGb: 0.023,
  storageAccount: 'acmesitiodatos', fileShare: 'sitio-datos', fileShareQuotaGb: 1,
  image: `ghcr.io/acme/arnes@sha256:${'a'.repeat(64)}`,
  tenantId: guid('2'), oidcClientId: guid('3'),
  mailbox: { resourceGroup: 'rg-buzon-acme', account: 'acmebuzon', container: 'corridas' },
  operationsRepo: 'https://git.acme.example/acme/operaciones', operationsIdentity: 'managed',
  firstMaintainer: 'lead@acme.example',
});
// 🔴 los valores de mentira se arman por partes: escritos enteros, el freno del remoto público los toma por secretos reales
const marca = (...p) => p.join('-');
const SECRETOS = {
  SITE_SESSION_KEY: marca('LLAVE', 'DE-SESION-QUE-NO-DEBE-APARECER-0123456789abcdef'),
  SITE_OIDC_CLIENT_SECRET: marca('SECRETO', 'OIDC-QUE-NO-DEBE-APARECER'),
  SITE_OPERATIONS_WRITE_TOKEN: marca('TOKEN', 'DE-ESCRITURA-QUE-NO-DEBE-APARECER'),
};
const MARCADORES = [...Object.values(SECRETOS), 'LLAVE-DEL-AREA-QUE-NO-DEBE-APARECER', 'LLAVE-DE-LA-CUENTA-QUE-NO-DEBE-APARECER'];

let n = 0;
/** Corre el alta en una carpeta nueva: { status, out, llamadas: [{ paso, args, archivos }], fix }. */
function alta(args, { config = CONFIG(), env = SECRETOS, fixEnv = {}, fix = null } = {}) {
  n += 1;
  const dir = fix || path.join(tmp, `caso-${n}`);
  fs.mkdirSync(dir, { recursive: true });
  const cfg = path.join(dir, 'sitio.json');
  fs.writeFileSync(cfg, JSON.stringify(config, null, 2));
  const r = spawnSync(process.execPath, [ACA, '--config', cfg, ...args], {
    encoding: 'utf8', timeout: 60000,
    env: { PATH: process.env.PATH, HOME: dir, FIXAZ: dir, TYCON_AZ_CMD: AZ_DOBLE, TYCON_CONTAINER_APPS_POLL_MS: '1', ...env, ...fixEnv },
  });
  let llamadas = [];
  try {
    llamadas = fs.readFileSync(path.join(dir, 'llamadas.log'), 'utf8').split('\n').filter(Boolean).map((l) => {
      const [paso, json] = [l.slice(0, l.indexOf('\t')), l.slice(l.indexOf('\t') + 1)];
      return { paso, ...JSON.parse(json) };
    });
  } catch { llamadas = []; }
  return { status: r.status, out: `${r.stdout}${r.stderr}`, llamadas, fix: dir };
}
const sinMarcadores = (texto, donde) => { for (const m of MARCADORES) assert.ok(!texto.includes(m), `${donde} trae un secreto: ${m}`); };
const escrituras = (ll) => ll.filter((l) => /\b(create|register|update|set|put)\b/.test(l.args.join(' ')) || l.paso === 'rest');

test('T7 Aca_DosFasesEnOrdenYSinSecretosALaVista @story-2.30 @ac-5 @ac-8', () => {
  const amb = alta(['--dry-run', '--phase', 'ambiente']);
  assert.strictEqual(amb.status, 0, amb.out);
  const o = amb.out;
  const orden = ['provider register -n Microsoft.App', 'provider register -n Microsoft.OperationalInsights', 'group create', 'monitor log-analytics workspace create', 'managedEnvironments/env-sitio-acme'];
  const pos = orden.map((x) => o.indexOf(x));
  assert.ok(pos.every((p, i) => p >= 0 && (i === 0 || p > pos[i - 1])), `las órdenes de la fase ambiente, en orden: ${pos} · ${o}`);
  assert.match(o, /https:\/\/sitio-acme\.<defaultDomain del ambiente>/, 'imprime la dirección que tendrá el sitio');
  assert.match(o, /\/auth\/callback/);
  assert.match(o, /\/\.auth\/login\/aad\/callback/);
  assert.deepStrictEqual(amb.llamadas, [], '--dry-run no llama a az');
  sinMarcadores(o, 'el plan de la fase ambiente');

  const sit = alta(['--dry-run', '--phase', 'sitio']);
  assert.strictEqual(sit.status, 0, sit.out);
  const s = sit.out;
  const ordenSitio = ['storage account create', 'storage share-rm create', 'managedEnvironments/env-sitio-acme/storages/', 'containerapp create', 'role assignment create', 'containerapp auth microsoft update', 'containerapp auth update', 'containerapp ingress update'];
  const p2 = ordenSitio.map((x) => s.indexOf(x));
  assert.ok(p2.every((p, i) => p >= 0 && (i === 0 || p > p2[i - 1])), `las órdenes de la fase sitio, en orden, la entrada externa al final: ${p2}`);
  assert.match(s, /"external": false/, 'la aplicación nace con la entrada interna');
  assert.deepStrictEqual(sit.llamadas, []);
  sinMarcadores(s, 'el plan de la fase sitio');
  assert.match(s, /<secreto: SITE_SESSION_KEY>/, 'el secreto, tapado y nombrado');

  // sin SITE_SESSION_KEY: sale 1, la nombra, y no crea nada
  const { SITE_SESSION_KEY, ...sinLlave } = SECRETOS;
  const falta = alta(['--dry-run', '--phase', 'sitio'], { env: sinLlave });
  assert.strictEqual(falta.status, 1, falta.out);
  assert.match(falta.out, /SITE_SESSION_KEY/);
  assert.deepStrictEqual(falta.llamadas, []);
  const faltaApply = alta(['--apply', '--phase', 'sitio'], { env: sinLlave });
  assert.strictEqual(faltaApply.status, 1);
  assert.deepStrictEqual(escrituras(faltaApply.llamadas), [], 'sin la variable no se crea nada');
});

test('T8 Aca_EscalaACeroYUnaReplica @story-2.30 @ac-8', () => {
  const s = alta(['--dry-run', '--phase', 'sitio']).out;
  for (const x of ['"minReplicas": 0', '"maxReplicas": 1', '"cpu": 0.5', '"memory": "1Gi"', '"targetPort": 8080', '"allowInsecure": false',
    '"workloadProfileName": "Consumption"', '"mountPath": "/data"', '"storageType": "AzureFile"', '"name": "SITE_DATA_DIR"',
    '"value": "microsoft"', `"image": "ghcr.io/acme/arnes@sha256:${'a'.repeat(64)}"`, '"path": "/livez"',
    'storage account create -n acmesitiodatos', 'storage share-rm create --storage-account acmesitiodatos', '--quota 1',
    'containerapp ingress update -g rg-sitio-acme -n sitio-acme --type external --allow-insecure false']) {
    assert.ok(s.includes(x), `falta ${x}`);
  }
  assert.doesNotMatch(s, /acmebuzon[\s\S]*share-rm|share-rm[^\n]*acmebuzon/, 'el disco no va en la cuenta del buzón');
  // la imagen por etiqueta, rechazada
  const etiqueta = alta(['--dry-run', '--phase', 'sitio'], { config: { ...CONFIG(), image: 'ghcr.io/acme/arnes:2026.10.1' } });
  assert.strictEqual(etiqueta.status, 1);
  assert.match(etiqueta.out, /image/);
  // el disco en la cuenta del buzón, rechazado
  const misma = alta(['--dry-run', '--phase', 'sitio'], { config: { ...CONFIG(), storageAccount: 'acmebuzon' } });
  assert.strictEqual(misma.status, 1);
  assert.match(misma.out, /storageAccount/);
});

test('T9 Aca_SecretosPorReferencia @story-2.30 @ac-5 @ac-8', () => {
  const s = alta(['--dry-run', '--phase', 'sitio']).out;
  // cada secreto en `secrets` y su variable por `secretRef`; ninguno como valor común
  for (const [v, sec] of [['SITE_SESSION_KEY', 'site-session-key'], ['SITE_OIDC_CLIENT_SECRET', 'site-oidc-client-secret'], ['SITE_OPERATIONS_WRITE_TOKEN', 'site-operations-write-token']]) {
    assert.ok(s.includes(`"name": "${sec}"`), `el secreto ${sec}`);
    assert.match(s, new RegExp(`"name": "${v}",\\s*"secretRef": "${sec}"`), `${v} por secretRef`);
  }
  assert.match(s, /"name": "SITE_OPERATIONS_IDENTITY",\s*"value": "managed"/);
  assert.match(s, /"name": "SITE_MAILBOX_IDENTITY",\s*"value": "managed"/);
  assert.doesNotMatch(s, /SITE_OPERATIONS_TOKEN/, 'con la identidad, sin el token');
  assert.match(s, /"name": "SITE_FIRST_MAINTAINER",\s*"value": "lead@acme\.example"/, 'el primer mantenedor, variable común');
  assert.doesNotMatch(s, /--client-secret /, 'nunca el secreto por línea de órdenes');
  assert.doesNotMatch(s, /--secrets |--env-vars /, 'los secretos van en el archivo, no en la línea de órdenes');
  // una clave con forma de secreto en el archivo de configuración: rechazado
  for (const mala of [{ ...CONFIG(), sessionKey: 'x' }, { ...CONFIG(), mailbox: { ...CONFIG().mailbox, sas: 'x' } }, { ...CONFIG(), oidcClientSecret: 'x' }]) {
    const r = alta(['--dry-run', '--phase', 'sitio'], { config: mala });
    assert.strictEqual(r.status, 1, r.out);
    assert.match(r.out, /secreto/);
  }
  // con la cuenta dedicada (token), el token sí, por secretRef
  const tok = alta(['--dry-run', '--phase', 'sitio'], { config: { ...CONFIG(), operationsIdentity: 'token' }, env: { ...SECRETOS, SITE_OPERATIONS_TOKEN: marca('TOKEN', 'DE-LECTURA-QUE-NO-DEBE-APARECER') } });
  assert.strictEqual(tok.status, 0, tok.out);
  assert.match(tok.out, /"name": "SITE_OPERATIONS_TOKEN",\s*"secretRef": "site-operations-token"/);
  assert.ok(!tok.out.includes('TOKEN-DE-LECTURA-QUE-NO-DEBE-APARECER'));
  const sinTok = alta(['--dry-run', '--phase', 'sitio'], { config: { ...CONFIG(), operationsIdentity: 'token' } });
  assert.strictEqual(sinTok.status, 1);
  assert.match(sinTok.out, /SITE_OPERATIONS_TOKEN/);
});

test('T10 Aca_RolDeLecturaSobreElContenedor @story-2.30 @ac-5 @ac-8', () => {
  const s = alta(['--dry-run', '--phase', 'sitio']).out;
  const linea = s.split('\n').find((l) => l.includes('role assignment create'));
  assert.ok(linea, s);
  assert.match(linea, /--role "Storage Blob Data Reader"/);
  assert.match(linea, /--scope \/subscriptions\/1{8}-1{4}-1{4}-1{4}-1{12}\/resourceGroups\/rg-buzon-acme\/providers\/Microsoft\.Storage\/storageAccounts\/acmebuzon\/blobServices\/default\/containers\/corridas( |$)/);
  assert.match(linea, /--assignee-principal-type ServicePrincipal/);
});

test('T11 Aca_InicioIntegradoUnInquilino @story-2.30 @ac-8', () => {
  const s = alta(['--dry-run', '--phase', 'sitio']).out;
  const ms = s.split('\n').find((l) => l.includes('containerapp auth microsoft update'));
  const au = s.split('\n').find((l) => /containerapp auth update/.test(l));
  const t = guid('2');
  assert.ok(ms && au, s);
  // el inquilino va en el emisor: az no acepta --issuer y --tenant-id juntos
  assert.ok(ms.includes(`--issuer https://login.microsoftonline.com/${t}/v2.0`), ms);
  assert.doesNotMatch(ms, /--tenant-id/, 'sin --tenant-id junto al emisor');
  assert.ok(ms.includes('--client-secret-name site-oidc-client-secret') && ms.includes(`--allowed-audiences ${guid('3')}`) && ms.includes(`--client-id ${guid('3')}`), ms);
  assert.doesNotMatch(ms, /common|organizations/);
  for (const x of ['--unauthenticated-client-action RedirectToLoginPage', '--require-https true', '--enabled true']) assert.ok(au.includes(x), `falta ${x}: ${au}`);
  assert.match(s, /"name": "SITE_OIDC_ISSUER",\s*"value": "https:\/\/login\.microsoftonline\.com\/2{8}-2{4}-2{4}-2{4}-2{12}\/v2\.0"/);
});

test('T23 Candado_DejaLibreLaPaginaDeSalida @story-2.46 @ac-18', async () => {
  const au = alta(['--dry-run', '--phase', 'sitio']).out.split('\n').find((l) => /containerapp auth update/.test(l));
  const libres = (/--excluded-paths (\S+)/.exec(au || '') || [])[1];
  assert.ok(libres, `la orden del candado lleva rutas libres: ${au}`);
  const rutas = libres.split(',');
  for (const r of ['/healthz', '/livez', '/saliste', '/idioma', '/static/site.css', '/static/site.js', '/static/fonts/lato-400.woff2', '/static/fonts/lato-700.woff2']) assert.ok(rutas.includes(r), `falta ${r} entre las rutas libres: ${libres}`);
  assert.ok(rutas.every((r) => r.startsWith('/') && !r.includes('*')), `rutas exactas, sin comodines: ${libres}`);
  // cada ruta libre existe en el sitio sin sesión: ninguna manda a la persona al emisor
  const H = require('./lib/site-harness.js');
  const { arrancarEmisor } = require('./lib/fake-oidc.js');
  const emisor = await arrancarEmisor();
  const h = await H.arrancarSitio({ env: H.envBase({ SITE_OIDC_ISSUER: emisor.issuer }), fuentes: H.fuentesFijas({}) });
  try {
    for (const r of rutas) {
      const res = await h.pedir(r);
      assert.ok(!res.headers.location, `${r} no redirige (${res.status} → ${res.headers.location})`);
      if (r === '/idioma') assert.strictEqual(res.status, 405, '/idioma acepta sólo POST sin sesión');
      else assert.strictEqual(res.status, 200, `${r} contesta sin sesión`);
    }
  } finally { await h.cerrar(); await emisor.cerrar(); }
});

test('PruebaSinSesion_SalidaDetrasDelCandado_AvisaSinFallar @story-2.48 @ac-7 @story-2.51 @ac-8', async () => {
  const http = require('http');
  const CHECK = require(path.join(ROOT, 'scripts', 'site', 'check-deploy.js'));
  assert.ok(Array.isArray(CHECK.AVISOS) && CHECK.AVISOS.length === 1, 'el aviso es un vocabulario cerrado exportado');
  const AVISO = CHECK.AVISOS[0];
  // tras «Salir» el sitio no vuelve a entrar solo: el aviso dice lo que sí pasa, y las guías también
  assert.doesNotMatch(AVISO, /se vuelve a entrar/, 'el aviso no dice que se vuelve a entrar');
  assert.match(AVISO, /con el candado vencido, «Saliste» pasa antes por el inicio de sesión de la plataforma/);
  for (const g of ['organization-site.md', 'organization-site.en.md']) {
    const t = fs.readFileSync(path.join(ROOT, 'guides', g), 'utf8').replace(/\s+/g, ' ');
    assert.doesNotMatch(t, /deja entrar de nuevo sin preguntar|se vuelve a entrar; la receta|lets the person back in without asking|lets them back in without asking/, `${g}: no dice que tras Salir se vuelve a entrar`);
  }
  const EMISOR = 'https://login.acme.example/tenant/oauth2/v2.0/authorize';
  // un sitio de juguete bien cerrado; `/saliste` contesta lo que dice `salida`
  const levantar = (salida) => new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const ruta = req.url.split('?')[0];
      if (ruta === '/healthz') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end('{"ok":true}'); }
      if (ruta === '/saliste') return salida(res);
      if (ruta.startsWith('/api/')) { res.writeHead(401, { 'Cache-Control': 'no-store' }); return res.end(); }
      res.writeHead(302, { Location: `${EMISOR}?response_type=code&client_id=x&state=s`, 'Cache-Control': 'no-store' });
      return res.end();
    });
    s.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${s.address().port}`, cerrar: () => new Promise((r) => { s.closeAllConnections(); s.close(r); }) }));
  });
  // asíncrono: el sitio de juguete vive en este proceso y un spawnSync lo dejaría sin contestar
  const correr = (url, out) => new Promise((resolve) => {
    require('child_process').execFile(process.execPath, [path.join(ROOT, 'scripts', 'site', 'check-deploy.js'), '--url', url, '--out', out], { encoding: 'utf8', timeout: 60000 },
      (err, stdout, stderr) => resolve({ status: err ? (typeof err.code === 'number' ? err.code : null) : 0, stdout, stderr }));
  });
  const casos = [
    ['redirección al inicio de sesión de la plataforma', (res) => { res.writeHead(302, { Location: '/.auth/login/aad?post_login_redirect_uri=%2Fsaliste' }); res.end(); }, true],
    ['200 de la propia página', (res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html></html>'); }, false],
    ['404 de un sitio viejo', (res) => { res.writeHead(404); res.end(); }, false],
  ];
  for (const [nombre, salida, avisa] of casos) {
    const s = await levantar(salida);
    try {
      const out = path.join(tmp, `salida-${avisa}-${nombre.length}.json`);
      const r = await correr(s.url, out);
      const doc = JSON.parse(fs.readFileSync(out, 'utf8'));
      assert.strictEqual(r.status, 0, `${nombre}: la salida no cambia: ${r.stdout}${r.stderr}`);
      assert.strictEqual(doc.resultado, 'paso', nombre);
      if (avisa) {
        assert.deepStrictEqual(doc.avisos, [AVISO], nombre);
        assert.match(r.stdout, /🟠 check-deploy: aviso: la página de salida queda detrás del candado/);
        assert.match(r.stdout, /pasa/, 'sigue diciendo que pasa');
      } else {
        assert.ok(!doc.avisos || doc.avisos.length === 0, `${nombre}: sin aviso`);
        assert.doesNotMatch(r.stdout, /aviso/);
      }
    } finally { await s.cerrar(); }
  }
  // lo que se prueba es el código de salida: 0 con aviso (el actualizador no corre acá). El actualizador toma el 0 como bien
  const upd = fs.readFileSync(path.join(DEPLOY, 'update-site.js'), 'utf8');
  assert.match(upd, /r\.status === 0 \? \{ ok: true \}/, 'el código de salida 0 que esta prueba da con aviso es el que el actualizador toma como bien');
});

test('T12 Aca_SinCostoEscondido @story-2.30 @ac-9', () => {
  const plan = `${alta(['--dry-run', '--phase', 'ambiente']).out}\n${alta(['--dry-run', '--phase', 'sitio']).out}`;
  for (const prohibido of [/\bacr\b/, /keyvault/, /--infrastructure-subnet-resource-id/, /private-endpoint|privateEndpoint/, /workload-profile add/]) assert.doesNotMatch(plan, prohibido, `una orden de costo escondido: ${prohibido}`);
  assert.strictEqual((plan.match(/monitor log-analytics workspace create/g) || []).length, 1, 'una sola área de registros');
  assert.match(plan, /monitor log-analytics workspace create [^\n]*--retention-time 31 [^\n]*--quota 0\.023/);
  assert.doesNotMatch(plan, /--quota -1/);
  assert.strictEqual((plan.match(/storage account create/g) || []).length, 1, 'una sola cuenta de almacenamiento: la del disco');
  assert.match(plan, /"destination": "log-analytics"/, 'el ambiente con los registros en el área, explícito');
  assert.match(plan, /"customerId": "<customerId del área registros-sitio-acme>"/);
  assert.match(plan, /"workloadProfileType": "Consumption"/);
  assert.doesNotMatch(plan, /"workloadProfileType": "(?!Consumption)/, 'ningún perfil que no sea Consumption');
  // un tope por debajo de 0,023 (Azure lo rechaza) o ilimitado: sale 1 sin imprimir el plan
  for (const q of [0.02, -1, 0, 5]) {
    const r = alta(['--dry-run', '--phase', 'ambiente'], { config: { ...CONFIG(), logAnalyticsQuotaGb: q } });
    assert.strictEqual(r.status, 1, `tope ${q}: ${r.out}`);
    assert.doesNotMatch(r.out, /workspace create/, `tope ${q}: sin el plan`);
    assert.match(r.out, /logAnalyticsQuotaGb/);
  }
});

// con «cualquier cuenta», lo que pide Azure: el registro con tokens v2, sin asignación requerida y el emisor común
test('T12b 2.40-Instalacion_CualquierCuenta_DryRun @story-2.40 @ac-10', () => {
  const t = guid('2'); const app = guid('3');
  const r = alta(['--dry-run', '--phase', 'sitio'], { config: { ...CONFIG(), microsoftAccounts: 'any' } });
  assert.strictEqual(r.status, 0, r.out);
  const s = r.out;
  const linea = (rx) => s.split('\n').find((l) => rx.test(l));
  // el registro: varios inquilinos y cuentas personales, con tokens v2 en el mismo cambio (sin v2, Azure lo rechaza)
  const reg = linea(/az rest --method patch --url "?https:\/\/graph\.microsoft\.com\/v1\.0\/applications\(appId=/);
  assert.ok(reg && reg.includes(`applications(appId='${app}')`), s);
  assert.match(s, /"requestedAccessTokenVersion": 2/);
  assert.match(s, /"signInAudience": "AzureADandPersonalMicrosoftAccount"/);
  // antes, que el registro pida el correo verificado (sin eso nadie entra): se lee, no se pisa
  assert.ok(linea(new RegExp(`az ad app show --id ${app} --query "?optionalClaims\\.idToken\\[\\]\\.name`)), s);
  // la asignación requerida, fuera: quién entra lo decide la lista del sitio
  assert.ok(linea(new RegExp(`az ad sp update --id ${app} --set appRoleAssignmentRequired=false`)), s);
  // el candado de la plataforma en el emisor común; el sitio, con su modo y el inquilino de los invitados
  const ms = linea(/containerapp auth microsoft update/);
  assert.ok(ms.includes('--issuer https://login.microsoftonline.com/common/v2.0'), ms);
  assert.match(s, /"name": "SITE_OIDC_ISSUER",\s*"value": "https:\/\/login\.microsoftonline\.com\/common\/v2\.0"/);
  assert.match(s, /"name": "SITE_AUTH_MICROSOFT_ACCOUNTS",\s*"value": "any"/);
  assert.match(s, new RegExp(`"name": "SITE_AUTH_MICROSOFT_TENANT",\\s*"value": "${t}"`));
  // el orden: primero el sitio nuevo (con la lista), después se abre la puerta, y la entrada externa al final
  const pos = (rx) => s.search(rx);
  const orden = [/containerapp (create|update) /, /applications\(appId=/, /appRoleAssignmentRequired=false/, /containerapp auth microsoft update/, /containerapp ingress update/].map(pos);
  assert.ok(orden.every((p) => p >= 0), JSON.stringify(orden));
  assert.deepStrictEqual([...orden].sort((a, b) => a - b), orden, `el orden de los pasos: ${orden}`);
  // ningún permiso nuevo para el sitio: ni sobre el directorio ni otro rol que la lectura del buzón
  assert.doesNotMatch(s, /appRoleAssignedTo|AppRoleAssignment\.ReadWrite|User\.Invite|Directory\.|ad app permission|--api-permissions|requiredResourceAccess/);
  assert.deepStrictEqual(s.split('\n').filter((l) => /az role assignment create/.test(l)).map((l) => /--role (Storage Blob Data Reader|\S+)/.exec(l.replace(/['"]/g, ''))[1]), ['Storage Blob Data Reader']);
  sinMarcadores(s, 'el plan');
  // el inquilino escrito en mayúsculas sale en minúsculas (Entra lo publica así y el sitio compara letra por letra), y el
  // de las cuentas personales no es el de una organización
  const mayus = alta(['--dry-run', '--phase', 'sitio'], { config: { ...CONFIG(), microsoftAccounts: 'any', tenantId: guid('a').toUpperCase() } });
  assert.strictEqual(mayus.status, 0, mayus.out);
  assert.match(mayus.out, new RegExp(`"name": "SITE_AUTH_MICROSOFT_TENANT",\\s*"value": "${guid('a')}"`));
  const personales = alta(['--dry-run', '--phase', 'sitio'], { config: { ...CONFIG(), tenantId: ['9188040d', '6c67', '4c5b', 'b112', '36a304b66dad'].join('-') } });
  assert.strictEqual(personales.status, 1, personales.out);
  assert.match(personales.out, /tenantId: .*cuentas personales/);
  // un modo que no existe no imprime el plan
  const mal = alta(['--dry-run', '--phase', 'sitio'], { config: { ...CONFIG(), microsoftAccounts: 'todas' } });
  assert.strictEqual(mal.status, 1);
  assert.match(mal.out, /microsoftAccounts/);
  assert.doesNotMatch(mal.out, /containerapp create/);
});

// los pasos de «cualquier cuenta» corridos (contra el doble de az): el registro, la asignación y el candado se cambian
// después de la aplicación; sin las claims en el registro, frena antes de abrir nada
test('2.40-T12c Instalacion_CualquierCuenta_Aplica @story-2.40 @ac-10', () => {
  const app = guid('3');
  const amb = alta(['--apply', '--phase', 'ambiente']);
  assert.strictEqual(amb.status, 0, amb.out);
  const r = alta(['--apply', '--phase', 'sitio'], { config: { ...CONFIG(), microsoftAccounts: 'any' }, fix: amb.fix });
  assert.strictEqual(r.status, 0, r.out);
  const orden = ['aplicacion', 'rest', 'registro', 'inicio', 'entrada'];
  const idx = (pred) => r.llamadas.findIndex(pred);
  const reg = idx((l) => l.paso === 'rest' && l.args.includes('patch') && l.args.some((a) => a.includes(`applications(appId='${app}')`)));
  const asig = idx((l) => l.paso === 'registro' && l.args.join(' ').includes('sp update') && l.args.includes('appRoleAssignmentRequired=false'));
  const cand = idx((l) => l.paso === 'inicio' && l.args.includes('microsoft') && l.args.includes('https://login.microsoftonline.com/common/v2.0'));
  const crear = idx((l) => l.paso === 'aplicacion' && /create|update/.test(l.args[1]));
  const ext = idx((l) => l.paso === 'entrada');
  assert.ok([crear, reg, asig, cand, ext].every((i) => i >= 0), JSON.stringify({ crear, reg, asig, cand, ext, orden }));
  assert.ok(crear < reg && reg < asig && asig < cand && cand < ext, 'la aplicación nueva primero, la entrada externa al final');
  const cuerpo = Object.values(r.llamadas[reg].archivos || {})[0] || '';
  assert.match(cuerpo, /"requestedAccessTokenVersion":\s*2/);
  assert.match(cuerpo, /AzureADandPersonalMicrosoftAccount/);
  // un registro sin xms_edov: frena antes de cambiar el registro, y dice qué falta
  const amb2 = alta(['--apply', '--phase', 'ambiente']);
  const sin = alta(['--apply', '--phase', 'sitio'], { config: { ...CONFIG(), microsoftAccounts: 'any' }, fixEnv: { TYCON_AZ_CLAIMS: 'email' }, fix: amb2.fix });
  assert.strictEqual(sin.status, 1, sin.out);
  assert.match(sin.out, /no pide xms_edov/);
  assert.ok(!sin.llamadas.some((l) => l.paso === 'rest' && l.args.includes('patch')), 'no tocó el registro');
});

test('T13 Aca_SinSesionDeAz_NoPregunta @story-2.30 @ac-8', () => {
  const r = alta(['--apply', '--phase', 'ambiente'], { fixEnv: { TYCON_AZ_WITHOUT_SESSION: '1' } });
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /az login/);
  assert.deepStrictEqual(escrituras(r.llamadas), [], 'sin sesión no se crea nada');
  assert.deepStrictEqual(r.llamadas.map((l) => l.paso), ['sesion'], 'pregunta sólo por la sesión');
});

test('T29 Aca_FallaAMitad_SinEntradaExterna @story-2.30 @ac-8', () => {
  const amb = alta(['--apply', '--phase', 'ambiente']);
  assert.strictEqual(amb.status, 0, amb.out);
  assert.match(amb.out, /https:\/\/sitio-acme\.cielo-verde-1a2b3c4d\.eastus2\.azurecontainerapps\.io/, 'la dirección que tendrá el sitio');
  sinMarcadores(amb.out, 'la salida de la fase ambiente');
  for (const l of amb.llamadas) sinMarcadores(l.args.join(' '), 'una orden de az');
  // el cuerpo del ambiente lleva la llave del área en un archivo, nunca en la línea de órdenes
  const rest = amb.llamadas.find((l) => l.paso === 'rest');
  assert.ok(rest && Object.values(rest.archivos).some((t) => t.includes('LLAVE-DEL-AREA-QUE-NO-DEBE-APARECER')), 'la llave viaja en el archivo del cuerpo');
  const sit = alta(['--apply', '--phase', 'sitio'], { fix: amb.fix, fixEnv: { TYCON_AZ_FAIL: 'rol:create' } });
  assert.strictEqual(sit.status, 1, sit.out);
  assert.match(sit.out, /Owner o User Access Administrator/);
  assert.match(sit.out, /no es alcanzable desde afuera/);
  assert.match(sit.out, /quedó creado/);
  assert.ok(!sit.llamadas.some((l) => l.paso === 'entrada'), 'ninguna orden de entrada externa');
  assert.ok(!sit.llamadas.some((l) => l.paso === 'inicio'), 'nada después del paso que falló');
  sinMarcadores(sit.out, 'la salida de la fase sitio');
  // la segunda corrida sigue desde donde quedó: no vuelve a crear la aplicación, y esta vez abre la entrada al final
  const otra = alta(['--apply', '--phase', 'sitio'], { fix: amb.fix });
  assert.strictEqual(otra.status, 0, otra.out);
  const nuevas = otra.llamadas.slice(sit.llamadas.length);
  assert.ok(!nuevas.some((l) => l.paso === 'aplicacion' && l.args[1] === 'create'), 'la aplicación ya existía: no se crea de nuevo');
  assert.ok(!nuevas.some((l) => l.paso === 'almacen' && l.args.includes('create')), 'la cuenta ya existía');
  assert.strictEqual(nuevas[nuevas.length - 1].paso, 'entrada', 'la entrada externa, en el último paso');
  for (const l of [...sit.llamadas, ...otra.llamadas]) sinMarcadores(l.args.join(' '), 'una orden de az');
});

test('T29c Aca_IdentidadRecienCreada_SeReintentaConEspera @story-2.30 @ac-8 @ac-25', () => {
  // la identidad de la aplicación recién creada tarda en llegar a Entra ID: el rol falla «Cannot find user or service
  // principal in graph database» hasta que la ve. Se reintenta con espera, y sólo ese error
  const amb = alta(['--apply', '--phase', 'ambiente']);
  assert.strictEqual(amb.status, 0, amb.out);
  const sit = alta(['--apply', '--phase', 'sitio'], { fix: amb.fix, fixEnv: { TYCON_AZ_GRAPH_DELAY: '2' } });
  assert.strictEqual(sit.status, 0, sit.out);
  const roles = sit.llamadas.filter((l) => l.paso === 'rol' && l.args[1] === 'assignment' && l.args[2] === 'create');
  assert.strictEqual(roles.length, 3, `dos intentos fallidos y el tercero entra: ${roles.length}`);
  assert.match(sit.out, /Azure todavía no lo ve: intento 2 de 12/);
  assert.strictEqual(sit.llamadas[sit.llamadas.length - 1].paso, 'entrada', 'sigue hasta abrir la entrada');
  // un 403 (sin permiso) NO se reintenta: frena en el primer intento
  const amb2 = alta(['--apply', '--phase', 'ambiente']);
  const sin = alta(['--apply', '--phase', 'sitio'], { fix: amb2.fix, fixEnv: { TYCON_AZ_FAIL: 'rol:create' } });
  assert.strictEqual(sin.status, 1, sin.out);
  assert.strictEqual(sin.llamadas.filter((l) => l.paso === 'rol' && l.args[2] === 'create').length, 1, 'el 403 no se reintenta');
  assert.doesNotMatch(sin.out, /todavía no lo ve/);
});

test('T29d Aca_VolverACorrer_ActualizaImagenSecretosYVariables @story-2.30 @ac-8 @ac-25', () => {
  // volver a correr la fase sitio con la aplicación ya creada aplica los cambios (antes la salteaba por «ya existe»):
  // la imagen nueva, y pasar a leer operaciones con un token (sin la licencia de la identidad administrada)
  const amb = alta(['--apply', '--phase', 'ambiente']);
  assert.strictEqual(amb.status, 0, amb.out);
  const prim = alta(['--apply', '--phase', 'sitio'], { fix: amb.fix });
  assert.strictEqual(prim.status, 0, prim.out);
  const TOKEN_LECTURA = marca('TOKEN', 'DE-LECTURA-QUE-NO-DEBE-APARECER-AL-ACTUALIZAR');
  const nueva = `ghcr.io/acme/arnes@sha256:${'b'.repeat(64)}`;
  const otra = alta(['--apply', '--phase', 'sitio'], { fix: amb.fix, config: { ...CONFIG(), image: nueva, operationsIdentity: 'token' }, env: { ...SECRETOS, SITE_OPERATIONS_TOKEN: TOKEN_LECTURA } });
  assert.strictEqual(otra.status, 0, otra.out);
  const nuevas = otra.llamadas.slice(prim.llamadas.length);
  assert.ok(!nuevas.some((l) => l.paso === 'aplicacion' && l.args[1] === 'create'), 'no se crea de nuevo');
  const upd = nuevas.find((l) => l.paso === 'aplicacion' && l.args[1] === 'update');
  assert.ok(upd && upd.args.includes('--yaml'), 'se actualiza con el archivo');
  const y = JSON.parse(Object.values(upd.archivos)[0]);
  const cont = y.properties.template.containers[0];
  assert.strictEqual(cont.image, nueva, 'la imagen nueva');
  assert.ok(y.properties.configuration.secrets.some((s) => s.name === 'site-operations-token' && s.value === TOKEN_LECTURA), 'el secreto del token, en el archivo');
  assert.ok(cont.env.some((e) => e.name === 'SITE_OPERATIONS_TOKEN' && e.secretRef === 'site-operations-token'), 'su variable, por referencia');
  assert.ok(!cont.env.some((e) => e.name === 'SITE_OPERATIONS_IDENTITY'), 'sin la identidad administrada');
  assert.strictEqual(y.properties.configuration.ingress.external, true, 'un sitio ya abierto no se cierra al actualizar');
  // dice qué cambió, y el token no aparece en ninguna orden ni en la salida
  assert.match(otra.out, /La aplicación ya existe: se actualiza\./);
  assert.match(otra.out, /imagen: ghcr\.io\/acme\/arnes@sha256:a{64} → ghcr\.io\/acme\/arnes@sha256:b{64}/);
  assert.match(otra.out, /secretos: \+site-operations-token/);
  assert.match(otra.out, /variables: .*\+SITE_OPERATIONS_TOKEN.*-SITE_OPERATIONS_IDENTITY|variables: .*-SITE_OPERATIONS_IDENTITY.*\+SITE_OPERATIONS_TOKEN/);
  assert.match(otra.out, /entrada: externa \(queda así\)/);
  assert.ok(!otra.out.includes(TOKEN_LECTURA), 'el token no sale');
  for (const l of nuevas) assert.ok(!l.args.join(' ').includes(TOKEN_LECTURA), `ninguna orden lleva el token: ${l.args.join(' ')}`);
  assert.ok(!nuevas.some((l) => l.args[1] === 'secret' && l.args[2] === 'set'), 'nada de `secret set` con el valor por argumento');
});

test('T29b Aca_NoPudePreguntar_NoEsNoExiste @story-2.30 @ac-8', () => {
  // la regla de la casa: una salida vacía puede ser un comando que falló. Un `show` que falla por otra cosa que «no existe»
  // frena el alta con el motivo: no se crea de nuevo encima de lo que capaz ya está.
  let r = alta(['--apply', '--phase', 'ambiente'], { fixEnv: { TYCON_AZ_FAIL: 'grupo-recursos:show' } });
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /no pude saber si existe/);
  assert.ok(!r.llamadas.some((l) => l.paso === 'grupo-recursos' && l.args.includes('create')), 'no crea el grupo a ciegas');
  // la aplicación, igual: un show que falla no la manda a create sobre una existente
  const amb = alta(['--apply', '--phase', 'ambiente']);
  assert.strictEqual(amb.status, 0, amb.out);
  r = alta(['--apply', '--phase', 'sitio'], { fix: amb.fix, fixEnv: { TYCON_AZ_FAIL: 'aplicacion:show' } });
  assert.strictEqual(r.status, 1, r.out);
  assert.ok(!r.llamadas.slice(amb.llamadas.length).some((l) => l.paso === 'aplicacion' && l.args[1] === 'create'), 'no crea la aplicación a ciegas');
  // `az` que no está: lo dice como tal, no como «sin sesión»
  const sinAz = alta(['--apply', '--phase', 'ambiente'], { fixEnv: { TYCON_AZ_CMD: path.join(tmp, 'no-existe-az') } });
  assert.strictEqual(sinAz.status, 1);
  assert.match(sinAz.out, /no pude correr az/);
  assert.doesNotMatch(sinAz.out, /no hay sesión/);
  // una llave que vuelve vacía (o «None», lo que imprime -o tsv para un null) no viaja: frena antes de usarla
  const vacia = alta(['--apply', '--phase', 'ambiente'], { fixEnv: { TYCON_AZ_EMPTY_KEY: '1' } });
  assert.strictEqual(vacia.status, 1, vacia.out);
  assert.match(vacia.out, /vino vacía/);
  assert.ok(!vacia.llamadas.some((l) => l.paso === 'rest'), 'no crea el ambiente con una llave vacía');
  // una dirección del perfil con usuario y clave adentro: rechazada, como la del repo de operaciones
  const conClave = alta(['--dry-run', '--phase', 'sitio'], { config: { ...CONFIG(), profileRepo: 'https://u:p@git.acme.example/acme/perfil' } });
  assert.strictEqual(conClave.status, 1, conClave.out);
  assert.match(conClave.out, /profileRepo/);
});

test('T14 Render_SecretosSinValor @story-2.30 @ac-5 @ac-12', () => {
  const t = fs.readFileSync(path.join(DEPLOY, 'render.yaml'), 'utf8');
  assert.match(t, /^\s+plan: free$/m);
  assert.match(t, /^\s+runtime: image$/m);
  assert.match(t, new RegExp(`url: ghcr\\.io/acme/arnes@sha256:[0-9a-f]{64}`));
  assert.match(t, /^\s+healthCheckPath: \/livez$/m);
  // cada variable secreta: sync: false y sin value
  const bloques = t.split(/\n\s+- key: /).slice(1);
  const secretas = ['SITE_SESSION_KEY', 'SITE_OIDC_CLIENT_SECRET', 'SITE_OPERATIONS_TOKEN', 'SITE_MAILBOX_SAS', 'SITE_OPERATIONS_WRITE_TOKEN', 'SITE_PROFILE_TOKEN', 'SITE_PROFILE_WRITE_TOKEN', 'SITE_PIPELINES_TOKEN'];
  for (const k of secretas) {
    const b = bloques.find((x) => x.split('\n')[0].trim() === k);
    assert.ok(b, `falta ${k}`);
    assert.match(b, /sync: false/, `${k} con sync: false`);
    assert.doesNotMatch(b, /value:/, `${k} sin valor`);
  }
  assert.doesNotMatch(t, /\b(ghp_|github_pat_|sv=|sig=)/, 'ningún valor con forma de token');
});

test('T15 Alta_SinValoresDeUnaOrganizacion @story-2.30 @ac-23', () => {
  const archivos = [ACA, path.join(DEPLOY, 'render.yaml'), path.join(DEPLOY, 'local', 'compose.yaml'), path.join(DEPLOY, 'local', 'sitio.env.example'),
    path.join(ROOT, 'scripts', 'site', 'check-deploy.js'), path.join(ROOT, 'scripts', 'lib', 'notify.js'), path.join(ROOT, '.github', 'workflows', 'site-image.yml')];
  const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  for (const f of archivos) {
    const t = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(t, GUID, `${path.basename(f)}: un GUID`);
    assert.doesNotMatch(t, /dev\.azure\.com\/(?!acme\b)[a-z0-9-]+|\.visualstudio\.com/i, `${path.basename(f)}: una organización de Azure DevOps`);
    assert.doesNotMatch(t, /ghcr\.io\/(?!acme\/)[a-z0-9-]+\//i, `${path.basename(f)}: el nombre de una imagen real`);
    // el nombre del repo público, el de la organización que lo publica, y el producto con que trabaja (los controles del nombre público)
    assert.doesNotMatch(t, /tycon-harness|tycon-sa|tycon\.com|bizuit/i, `${path.basename(f)}: el nombre de una organización real o del repo público`);
    assert.doesNotMatch(t, /chat_id=\d|\b\d{9,}\b/, `${path.basename(f)}: un chat`);
  }
});

test('T36 Local_ComposeSinSecretosYSoloRedInterna @story-2.30 @ac-5 @ac-13', () => {
  const c = fs.readFileSync(path.join(DEPLOY, 'local', 'compose.yaml'), 'utf8');
  // la imagen por huella: la de SITE_IMAGE (la resuelve start.js --update) o la fija de abajo, nunca una etiqueta
  assert.match(c, new RegExp(`image: \\$\\{SITE_IMAGE:-ghcr\\.io/acme/arnes@sha256:[0-9a-f]{64}\\}`));
  assert.match(c, /labels:\n {6}tycon\.site: local\n/, 'la etiqueta con la que harness.js update lo reconoce');
  assert.match(c, /- "127\.0\.0\.1:8080:8080"/, 'el puerto sólo en 127.0.0.1');
  assert.doesNotMatch(c, /- "?8080:8080"?$/m, 'nunca en todas las interfaces');
  // el archivo de secretos llega por una variable que pone el arranque (start.js): nunca un sitio.env al lado, en el repo
  assert.match(c, /env_file:\s*\n\s+- \$\{SITE_ENV_FILE:\?[^}]+\}/);
  assert.doesNotMatch(c, /^\s+- sitio\.env$/m);
  const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  assert.match(gi, /^\*\*\/sitio\.env$/m, 'un sitio.env olvidado en el repo no se commitea');
  assert.match(c, /- sitio-datos:\/data/);
  assert.match(c, /^volumes:\n {2}sitio-datos:/m, 'un volumen con nombre');
  assert.match(c, /SITE_DATA_DIR: \/data/);
  const env = (c.match(/environment:\n((?: {6}.*\n)*)/) || [])[1] || '';
  assert.doesNotMatch(env, /SESSION|SECRET|TOKEN|SAS/, 'ningún secreto en environment:');
  const ej = fs.readFileSync(path.join(DEPLOY, 'local', 'sitio.env.example'), 'utf8');
  const lineas = ej.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
  const nombres = lineas.map((l) => l.split('=')[0]);
  for (const v of ['SITE_PUBLIC_URL', 'SITE_SESSION_KEY', 'SITE_AUTH_PROVIDER', 'SITE_OIDC_CLIENT_ID', 'SITE_OIDC_CLIENT_SECRET', 'SITE_OPERATIONS_REPO', 'SITE_OPERATIONS_TOKEN', 'SITE_MAILBOX_SAS', 'SITE_FIRST_MAINTAINER']) {
    assert.ok(nombres.includes(v), `el ejemplo trae ${v}`);
  }
  for (const l of lineas) assert.match(l, /^[A-Z_]+=$/, `sin valor: ${l}`);
  // las opcionales de la configuración desde el sitio, comentadas
  for (const v of ['SITE_OPERATIONS_WRITE_TOKEN', 'SITE_PROFILE_REPO', 'SITE_PROFILE_TOKEN', 'SITE_PROFILE_WRITE_TOKEN', 'SITE_PIPELINES_TOKEN']) {
    assert.match(ej, new RegExp(`^# ${v}=$`, 'm'), `${v}, comentada y vacía`);
  }
});

test('T36b Local_ArranqueSeNiegaConElArchivoEnUnRepo @story-2.30 @ac-5 @ac-13', () => {
  const START = path.join(DEPLOY, 'local', 'start.js');
  const correr = (args) => spawnSync(process.execPath, [START, ...args], { encoding: 'utf8', timeout: 30000, env: { PATH: process.env.PATH, HOME: tmp } });
  // dentro de un repo git: se niega, y no arranca nada
  const repo = path.join(tmp, 'un-repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'adentro'), { recursive: true });
  const enRepo = path.join(repo, 'adentro', 'sitio.env');
  fs.writeFileSync(enRepo, 'SITE_SESSION_KEY=\n', { mode: 0o600 });
  let r = correr(['--secrets-file', enRepo, '--dry-run']);
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /dentro de un repo git/);
  // un worktree (`.git` es un archivo) también es un repo
  const wt = path.join(tmp, 'un-worktree');
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), 'gitdir: /x\n');
  fs.writeFileSync(path.join(wt, 'sitio.env'), '', { mode: 0o600 });
  assert.strictEqual(correr(['--secrets-file', path.join(wt, 'sitio.env'), '--dry-run']).status, 1);
  // un enlace simbólico fuera del repo que apunta a un archivo DENTRO de un repo: se niega igual
  const enlaceDir = path.join(tmp, 'enlaces');
  fs.mkdirSync(enlaceDir, { recursive: true });
  const enlace = path.join(enlaceDir, 'sitio.env');
  fs.rmSync(enlace, { force: true });
  fs.symlinkSync(enRepo, enlace);
  r = correr(['--secrets-file', enlace, '--dry-run']);
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /dentro de un repo git/);
  // un archivo que está pero no se puede abrir (una carpeta con ese nombre): lo dice, no «no lo encuentro»
  const carpeta = path.join(tmp, 'carpeta-sitio');
  fs.mkdirSync(path.join(carpeta, 'sitio.env'), { recursive: true });
  r = correr(['--secrets-file', path.join(carpeta, 'sitio.env'), '--dry-run']);
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.doesNotMatch(r.stderr, /no encuentro/);
  // fuera de todo repo, pero legible por otros: se niega
  const fuera = path.join(tmp, 'secretos-del-sitio');
  fs.mkdirSync(fuera, { recursive: true });
  const abierto = path.join(fuera, 'sitio.env');
  fs.writeFileSync(abierto, '');
  fs.chmodSync(abierto, 0o644);
  r = correr(['--secrets-file', abierto, '--dry-run']);
  if (process.platform !== 'win32') { assert.strictEqual(r.status, 1, r.stdout + r.stderr); assert.match(r.stderr, /chmod 600/); }
  // fuera de todo repo y sólo del dueño: arranca (en ensayo, dice la orden)
  fs.chmodSync(abierto, 0o600);
  r = correr(['--secrets-file', abierto, '--dry-run']);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /docker compose -f .*compose\.yaml up -d/);
  assert.ok(r.stdout.includes(`SITE_ENV_FILE=${abierto}`));
  // sin el archivo, o sin la opción: uso
  assert.strictEqual(correr(['--secrets-file', path.join(fuera, 'no-esta.env'), '--dry-run']).status, 1);
  assert.strictEqual(correr(['--dry-run']).status, 2);
});

test('T9b Aca_SecretosDeYProblemas_Directos @story-2.30 @ac-5 @ac-8', () => {
  const { secretosDe, problemas } = require(ACA);
  // con la identidad: pide la llave de la sesión y el secreto del inicio; las opcionales, sólo si vienen
  let s = secretosDe(CONFIG(), { SITE_SESSION_KEY: 'x', SITE_PIPELINES_TOKEN: 'y' });
  assert.deepStrictEqual(s.faltan, ['SITE_OIDC_CLIENT_SECRET']);
  assert.ok(s.vinieron.some(([v]) => v === 'SITE_PIPELINES_TOKEN'));
  assert.ok(s.apagadas.includes('SITE_OPERATIONS_WRITE_TOKEN') && !s.apagadas.includes('SITE_PIPELINES_TOKEN'));
  // con la cuenta dedicada, también el token de lectura
  s = secretosDe({ ...CONFIG(), operationsIdentity: 'token' }, {});
  assert.deepStrictEqual(s.faltan, ['SITE_SESSION_KEY', 'SITE_OIDC_CLIENT_SECRET', 'SITE_OPERATIONS_TOKEN']);
  // la configuración inventada sirve; una clave de secreto, no
  assert.deepStrictEqual(problemas(CONFIG(), 'sitio'), []);
  assert.ok(problemas({ ...CONFIG(), webhookToken: 'x' }, 'sitio').some((p) => /no lleva secretos/.test(p)));
});

test('T38 Sondas_VidaContraLivez_VariablesPrevistas @story-2.30 @ac-4 @ac-5 @ac-8 @ac-12 @ac-13', () => {
  const s = alta(['--dry-run', '--phase', 'sitio']).out;
  assert.match(s, /"type": "Liveness",\s*"httpGet": \{\s*"path": "\/livez"/);
  // la de «lista» también contra /livez: contra /readyz la plataforma no manda tráfico hasta tener el buzón entero
  assert.match(s, /"type": "Readiness",\s*"httpGet": \{\s*"path": "\/livez"/);
  assert.doesNotMatch(s, /"path": "\/(readyz|healthz)"/, 'ninguna sonda espera todo ni se cae con el sitio frenado');
  for (const tipo of ['Liveness', 'Readiness']) assert.match(s, new RegExp(`"type": "${tipo}"[^}]*\\}[^}]*"timeoutSeconds": 5`), `${tipo}: plazo de 5 s`);
  assert.doesNotMatch(s, /"type": "Liveness",\s*"httpGet": \{\s*"path": "\/healthz"/, 'nunca la vida contra /healthz');
  const render = fs.readFileSync(path.join(DEPLOY, 'render.yaml'), 'utf8');
  assert.doesNotMatch(render, /healthCheckPath: \/healthz/);
  assert.match(render, /- key: SITE_FIRST_MAINTAINER\n\s+sync: false/);
  // las opcionales de la configuración desde el sitio: sin valor en el plan cuando no vienen en el entorno
  const { SITE_OPERATIONS_WRITE_TOKEN, ...sinOpcionales } = SECRETOS;
  const p = alta(['--dry-run', '--phase', 'sitio'], { env: sinOpcionales }).out;
  for (const v of ['SITE_OPERATIONS_WRITE_TOKEN', 'SITE_PROFILE_TOKEN', 'SITE_PROFILE_WRITE_TOKEN', 'SITE_PIPELINES_TOKEN']) {
    assert.doesNotMatch(p, new RegExp(`"name": "${v}"`), `${v} apagada si no viene`);
  }
  assert.match(p, /apagadas.*SITE_OPERATIONS_WRITE_TOKEN/s, 'el plan dice cuáles quedan apagadas');
});

// ── la guía y el registro (T32, T33, T42) ───────────────────────────────────────────────────────────────────────
const GUIA = path.join(ROOT, 'guides', 'organization-site.md');
const GUIA_EN = path.join(ROOT, 'guides', 'organization-site.en.md');
/** El texto de una sección `## <título>` hasta la próxima `## `. */
const seccion = (t, titulo) => { const i = t.indexOf(`\n## ${titulo}`); if (i < 0) return null; const j = t.indexOf('\n## ', i + 4); return t.slice(i, j < 0 ? undefined : j); };
const sub = (t, titulo) => { const i = t.indexOf(`\n### ${titulo}`); if (i < 0) return null; const j = t.slice(i + 5).search(/\n#{2,3} /); return t.slice(i, j < 0 ? undefined : i + 5 + j); };

test('T32 Guia_ParteComunYUnaRecetaPorInstalacion @story-2.30 @ac-3 @ac-4 @ac-5 @ac-7 @ac-11 @ac-12 @ac-13', () => {
  const t = fs.readFileSync(GUIA, 'utf8');
  const comun = seccion(t, 'Lo común a cualquier instalación');
  assert.ok(comun, 'la parte común');
  for (const nube of ['az ', 'azurecontainerapps', 'render.com', 'Container Apps', 'Render']) assert.ok(!comun.includes(nube), `la parte común nombra una nube: ${nube}`);
  for (const x of ['https', '8080', 'SITE_DATA_DIR', '1 GB', '/livez', '/readyz', '/healthz', 'SITE_FIRST_MAINTAINER', 'SITE_SESSION_KEY', 'SITE_OIDC_CLIENT_SECRET',
    'SITE_OPERATIONS_TOKEN', 'SITE_MAILBOX_SAS', 'SITE_OPERATIONS_WRITE_TOKEN', 'docker run', 'node scripts/site/server.js', 'check-deploy.js', 'política de rama', 'hacerse mantenedor']) {
    assert.ok(comun.includes(x), `la parte común no dice ${x}`);
  }
  const recetas = seccion(t, 'Las recetas');
  assert.ok(recetas, 'las recetas');
  for (const r of ['Azure Container Apps', 'Render', 'Una máquina propia']) {
    const b = sub(recetas, r);
    assert.ok(b, `la receta ${r}`);
    for (const rubro of ['Inicio de sesión', 'Disco', 'Secretos', 'Se duerme']) assert.ok(b.includes(`**${rubro}`), `la receta ${r} no dice «${rubro}»`);
  }
  const local = sub(recetas, 'Una máquina propia');
  const orden = ['red interna', 'VPN', 'túnel'].map((x) => local.indexOf(x));
  assert.ok(orden.every((p, i) => p >= 0 && (i === 0 || p > orden[i - 1])), `las tres formas de llegar, en orden: ${orden}`);
  const index = fs.readFileSync(path.join(ROOT, 'INDEX.md'), 'utf8');
  assert.match(index, /\| [^|]*sitio de la organizaci[^|]*\| `guides\/organization-site\.md`/, 'la fila del INDEX');
});

test('T42 Guia_InstalacionCompletaYEnIngles @story-2.30 @ac-7', () => {
  const es = fs.readFileSync(GUIA, 'utf8');
  const en = fs.readFileSync(GUIA_EN, 'utf8');
  const titulos = (t) => [...t.matchAll(/^(##+) /gm)].map((m) => m[1]);
  assert.deepStrictEqual(titulos(en), titulos(es), 'las mismas secciones, en el mismo orden');
  const orden = ['## Qué es y para qué sirve', '## Qué hace falta antes', '## Probarlo en tu máquina con Docker', '## Lo común a cualquier instalación', '## Las recetas'].map((x) => es.indexOf(x));
  assert.ok(orden.every((p, i) => p >= 0 && (i === 0 || p > orden[i - 1])), `qué es, qué hace falta y la prueba local, antes de lo común y las recetas: ${orden}`);
  const ordenEn = ['## What it is and what it is for', '## What you need first', '## Try it on your machine with Docker', '## Common to every installation', '## The recipes'].map((x) => en.indexOf(x));
  assert.ok(ordenEn.every((p, i) => p >= 0 && (i === 0 || p > ordenEn[i - 1])), `lo mismo en inglés: ${ordenEn}`);
  // lo no probado en real lo dice
  assert.match(es, /no se probó en real/i);
  assert.match(en, /not (been )?tested for real/i);
  // los comandos de la prueba local son los que corren hoy
  for (const t of [es, en]) {
    assert.match(t, /docker buildx build -f scripts\/site\/Dockerfile -t sitio:local \./);
    assert.match(t, /-p 127\.0\.0\.1:8080:8080/);
    assert.match(t, /node scripts\/site\/check-deploy\.js --url/);
  }
  assert.doesNotMatch(es + en, /TYCON-SA|tycon-harness|story \d|2\.\d\d\b/i, 'sin nombres reales ni números de story');
});

test('T33 Registro_SuitesPiezasYReadmes @story-2.30 @ac-24', () => {
  const suites = fs.readFileSync(path.join(ROOT, 'scripts', 'tests', 'suites.json'), 'utf8');
  for (const s of ['site-image-workflow.test.js', 'site-check-deploy.test.js', 'site-deploy.test.js', 'notify.test.js']) assert.ok(suites.includes(`"tests/${s}"`), `suites.json no registra ${s}`);
  const piezas = fs.readFileSync(path.join(ROOT, 'guides', 'piezas-del-arnes.md'), 'utf8');
  for (const p of ['scripts/lib/notify.js', 'scripts/site/check-deploy.js', 'scripts/site/deploy/', '.github/workflows/site-image.yml', 'guides/organization-site.md']) assert.ok(piezas.includes(p), `piezas-del-arnes.md no nombra ${p}`);
  const ficha = seccion(piezas, 'scripts/site/ — el sitio de la organización');
  assert.ok(ficha && ficha.split('\n').length <= 25, `la ficha del sitio es corta (${ficha && ficha.split('\n').length} líneas)`);
  for (const r of ['pipelines/operations/README.md', 'pipelines/operations/github/README.md']) {
    const t = fs.readFileSync(path.join(ROOT, r), 'utf8');
    assert.match(t, /Sin\s+`notify`, no se manda/, `${r}: sin notify, no se manda`);
    assert.match(t, /política de rama|protección de `operations\.json`/i, `${r}: la política de rama`);
  }
});

test('T24 2.34-Alta_CopiaSinTokenNiLlave @story-2.34 @ac-11 — la copia: cuenta sin llave, contenedor, rol de lector y `copy`', () => {
  // 🔴 rojo: el alta deja la llave de la cuenta prendida, o sigue pidiendo SITE_OPERATIONS_TOKEN o la identidad en Azure DevOps.
  const COPIA = { resourceGroup: 'rg-sitio-acme', account: 'acmecopiaops', container: 'operaciones' };
  const conf = { ...CONFIG(), operationsIdentity: 'copy', operationsCopy: COPIA };
  const r = alta(['--dry-run', '--phase', 'sitio'], { config: conf });
  assert.strictEqual(r.status, 0, r.out);
  assert.deepStrictEqual(r.llamadas.filter((l) => escrituras([l]).length), [], 'el ensayo no escribe nada en az');
  const lineas = r.out.split('\n');
  const cuenta = lineas.find((l) => l.includes('storage account create') && l.includes(COPIA.account));
  assert.ok(cuenta, r.out);
  assert.match(cuenta, /--allow-shared-key-access false/, 'la llave apagada');
  assert.match(cuenta, /--allow-blob-public-access false/);
  const cont = lineas.find((l) => l.includes('storage container-rm create'));
  assert.ok(cont && cont.includes(`--storage-account ${COPIA.account}`) && cont.includes(`-n ${COPIA.container}`), r.out);
  const alcance = `/storageAccounts/${COPIA.account}/blobServices/default/containers/${COPIA.container}`;
  const rol = lineas.find((l) => l.includes('role assignment create') && l.includes(alcance));
  assert.ok(rol, `el rol de lector sobre el contenedor de la copia: ${r.out}`);
  assert.match(rol, /--role "Storage Blob Data Reader"/);
  assert.match(r.out, /"name": "SITE_OPERATIONS_SOURCE",\s*"value": "copy"/);
  assert.match(r.out, new RegExp(`"name": "SITE_OPERATIONS_COPY",\\s*"value": "${COPIA.account}/${COPIA.container}"`));
  assert.doesNotMatch(r.out, /SITE_OPERATIONS_TOKEN|SITE_OPERATIONS_IDENTITY/, 'ni el token ni la identidad en Azure DevOps');
  assert.match(r.out, /Storage Blob Data Contributor/, 'dice la orden del rol de escritura del trabajo que copia');
  sinMarcadores(r.out, 'el plan');
  // una copia mal escrita, o en la cuenta del disco o del buzón: no
  for (const mala of [{ ...COPIA, account: 'Mal' }, { ...COPIA, account: CONFIG().storageAccount }, { ...COPIA, account: CONFIG().mailbox.account }]) {
    const m = alta(['--dry-run', '--phase', 'sitio'], { config: { ...conf, operationsCopy: mala } });
    assert.strictEqual(m.status, 1, m.out);
    assert.match(m.out, /operationsCopy/);
  }
  // con `--apply`, el doble recuerda los dos roles por su alcance: el del buzón no tapa el de la copia
  const amb = alta(['--apply', '--phase', 'ambiente'], { config: conf });
  assert.strictEqual(amb.status, 0, amb.out);
  const ap = alta(['--apply', '--phase', 'sitio'], { fix: amb.fix, config: conf });
  assert.strictEqual(ap.status, 0, ap.out);
  const roles = ap.llamadas.filter((l) => l.paso === 'rol' && l.args.includes('create')).map((l) => l.args[l.args.indexOf('--scope') + 1]);
  assert.ok(roles.some((s) => s.endsWith(alcance)) && roles.some((s) => s.includes(CONFIG().mailbox.account)), JSON.stringify(roles));
});

test('A10 2.34-Adv_CuentaExistenteQuedaSinLlave @story-2.34 @ac-11 — una cuenta de la copia que ya existe queda con la llave apagada', () => {
  // 🔴 rojo: la cuenta ya existía con la llave prendida y el alta la acepta: quien tenga la llave puede escribir la copia.
  const COPIA = { resourceGroup: 'rg-sitio-acme', account: 'acmecopiaops', container: 'operaciones' };
  const conf = { ...CONFIG(), operationsIdentity: 'copy', operationsCopy: COPIA };
  const amb = alta(['--apply', '--phase', 'ambiente'], { config: conf });
  assert.strictEqual(amb.status, 0, amb.out);
  const uno = alta(['--apply', '--phase', 'sitio'], { fix: amb.fix, config: conf });
  assert.strictEqual(uno.status, 0, uno.out);
  const dos = alta(['--apply', '--phase', 'sitio'], { fix: amb.fix, config: conf });
  assert.strictEqual(dos.status, 0, dos.out);
  const upd = dos.llamadas.filter((l) => l.args.slice(0, 3).join(' ') === 'storage account update' && l.args.includes(COPIA.account));
  assert.strictEqual(upd.length, 1, dos.out);
  assert.ok(upd[0].args.join(' ').includes('--allow-shared-key-access false'));
});

// el permiso de invitar, una fase aparte que corre un administrador del directorio. La aplicación ya existe
// (se siembra en el estado del doble, como la deja la fase sitio)
function conSitioCreado(fixEnv = {}) {
  n += 1;
  const dir = path.join(tmp, `caso-${n}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'azure.json'), JSON.stringify({ 'containerapp|sitio-acme': true }));
  return { dir, correr: (args) => alta(args, { fix: dir, fixEnv }) };
}
const asignacion = (ll) => ll.find((l) => l.paso === 'rest' && /appRoleAssignments/.test(l.args.join(' ')) && /post/i.test(l.args.join(' ')));

test('T13 2.74-Instalador_PermisoDeInvitar_DryRunYApply @story-2.74 @ac-11', () => {
  const ensayo = conSitioCreado().correr(['--dry-run', '--phase', 'permiso-de-invitar']);
  assert.strictEqual(ensayo.status, 0, ensayo.out);
  assert.match(ensayo.out, /User\.Invite\.All/);
  assert.match(ensayo.out, /appRoleAssignments/);
  assert.match(ensayo.out, /administrador del directorio/);
  assert.strictEqual(asignacion(ensayo.llamadas), undefined, 'el ensayo no asigna nada');
  const bien = conSitioCreado().correr(['--apply', '--phase', 'permiso-de-invitar']);
  assert.strictEqual(bien.status, 0, bien.out);
  const a = asignacion(bien.llamadas);
  assert.ok(a, bien.out);
  const cuerpo = JSON.parse(Object.values(a.archivos)[0]);
  assert.deepStrictEqual(cuerpo, { principalId: 'principal-del-sitio', resourceId: 'principal-de-graph', appRoleId: 'rol-de-invitar' });
  // sin el rol de administrador: lo dice y no deja nada a medias
  const sinRol = conSitioCreado({ TYCON_AZ_NOT_ADMIN: '1' }).correr(['--apply', '--phase', 'permiso-de-invitar']);
  assert.strictEqual(sinRol.status, 1, sinRol.out);
  assert.match(sinRol.out, /administrador del directorio/);
  assert.ok(!sinRol.llamadas.some((l) => l.paso === 'aplicacion' && l.args.includes('update')), 'no cambia la aplicación');
});

test('2.74-Adv_ActualizarElSitio_ConservaElCodigoPorCorreo @story-2.74 @ac-11 — volver a correr la fase sitio no lo borra', () => {
  const caso = conSitioCreado({ TYCON_AZ_EMAIL_CODE_POLICY: 'disabled' });
  assert.strictEqual(caso.correr(['--apply', '--phase', 'ambiente']).status, 0);
  assert.strictEqual(caso.correr(['--apply', '--phase', 'permiso-de-invitar']).status, 0);
  const otra = caso.correr(['--apply', '--phase', 'sitio']);
  assert.strictEqual(otra.status, 0, otra.out);
  const yaml = otra.llamadas.filter((l) => l.paso === 'aplicacion' && l.args.includes('--yaml')).pop();
  assert.ok(yaml, otra.out);
  const env = JSON.parse(Object.values(yaml.archivos)[0]).properties.template.containers[0].env;
  assert.deepStrictEqual(env.filter((e) => e.name === 'SITE_INVITE_EMAIL_CODE'), [{ name: 'SITE_INVITE_EMAIL_CODE', value: 'off' }]);
});

test('T21 2.74-Instalador_CodigoPorCorreo @story-2.74 @ac-11 @ac-12', () => {
  for (const [politica, valor] of [['enabled', 'on'], ['default', 'on'], ['disabled', 'off'], ['denied', 'unknown']]) {
    const r = conSitioCreado({ TYCON_AZ_EMAIL_CODE_POLICY: politica }).correr(['--apply', '--phase', 'permiso-de-invitar']);
    assert.strictEqual(r.status, 0, `${politica}: ${r.out}`);
    const upd = r.llamadas.find((l) => l.paso === 'aplicacion' && l.args.includes('update') && l.args.includes('--set-env-vars'));
    assert.ok(upd, `${politica}: ${r.out}`);
    assert.ok(upd.args.includes(`SITE_INVITE_EMAIL_CODE=${valor}`), `${politica} → ${valor}: ${upd.args.join(' ')}`);
    if (valor === 'unknown') assert.match(r.out, /portal/, 'dice dónde mirarlo');
  }
});

// ── la fase `demo` ───────────────────────────────────────────────────────────────────────────────────────────────────
// El sitio demo es una instancia aparte: abierta, sin candado, sin disco, sin identidad y sin ningún secreto. Usa el
// ambiente que crea la fase `ambiente`; no acepta buzón, repo ni inquilino.
const CONFIG_DEMO = () => ({
  subscription: guid('1'), resourceGroup: 'rg-demo-acme', location: 'eastus2',
  environment: 'env-demo-acme', app: 'demo-acme', logAnalyticsWorkspace: 'registros-demo-acme', logAnalyticsQuotaGb: 0.023,
  image: `ghcr.io/acme/arnes@sha256:${'a'.repeat(64)}`,
});

test('2.76-Instalador_FaseDemo_DryRunYApply', () => {
  // (1) el ensayo: cada paso a la vista, sin llamar a az y sin pedir ni un secreto
  const ens = alta(['--dry-run', '--phase', 'demo'], { config: CONFIG_DEMO(), env: {} });
  assert.strictEqual(ens.status, 0, ens.out);
  assert.deepStrictEqual(ens.llamadas, [], '--dry-run no llama a az');
  assert.match(ens.out, /fase demo/);
  assert.match(ens.out, /containerapp create/);
  assert.match(ens.out, /https:\/\/demo-acme\.<defaultDomain del ambiente>/, 'imprime el link que tendrá');
  const plan = ens.out;
  for (const x of ['"name": "SITE_DEMO"', '"value": "1"', '"external": true', '"minReplicas": 0', '"maxReplicas": 1', '"path": "/livez"', '"name": "SITE_PUBLIC_URL"']) assert.ok(plan.includes(x), `el plan trae ${x}`);
  for (const x of ['secrets', 'secretRef', 'volumes', 'volumeMounts', '"identity"', 'storage account', 'share-rm', 'role assignment', 'containerapp auth', 'ingress update', 'SITE_SESSION_KEY', 'SITE_OIDC', 'SITE_DATA_DIR', 'SITE_OPERATIONS', 'SITE_MAILBOX']) {
    assert.ok(!plan.includes(x), `el plan de la instancia demo no trae «${x}»: sin candado, sin disco, sin identidad, sin secretos`);
  }

  // (2) rechaza lo que es de la instancia de la organización: buzón, repo, inquilino, disco, correos, secretos
  const rechazados = { mailbox: { resourceGroup: 'rg-buzon-acme', account: 'acmebuzon', container: 'corridas' }, operationsRepo: 'https://git.acme.example/acme/operaciones', operationsIdentity: 'token',
    tenantId: guid('2'), oidcClientId: guid('3'), storageAccount: 'acmesitiodatos', fileShare: 'sitio-datos', fileShareQuotaGb: 1, firstMaintainer: 'lead@acme.example',
    profileRepo: 'https://git.acme.example/acme/perfil', microsoftAccounts: 'any', operationsCopy: { resourceGroup: 'rg', account: 'acmecopia', container: 'copia' }, sessionToken: 'x' };
  for (const [k, v] of Object.entries(rechazados)) {
    const r = alta(['--dry-run', '--phase', 'demo'], { config: { ...CONFIG_DEMO(), [k]: v }, env: {} });
    assert.strictEqual(r.status, 1, `${k}: no se acepta`);
    assert.ok(r.out.includes(k), `${k}: el error lo nombra: ${r.out}`);
    assert.deepStrictEqual(r.llamadas, []);
  }
  // sin lo mínimo (la imagen por su huella), tampoco
  const { image, ...sinImagen } = CONFIG_DEMO();
  assert.strictEqual(alta(['--dry-run', '--phase', 'demo'], { config: sinImagen, env: {} }).status, 1);
  assert.strictEqual(alta(['--dry-run', '--phase', 'demo'], { config: { ...CONFIG_DEMO(), image: 'ghcr.io/acme/arnes:stable' }, env: {} }).status, 1, 'la imagen va por su huella, nunca por etiqueta');

  // (3) --apply sobre el ambiente que ya creó la fase ambiente: la instancia aparte, sin nada de lo de la organización
  const amb = alta(['--apply', '--phase', 'ambiente'], { config: CONFIG_DEMO(), env: {} });
  assert.strictEqual(amb.status, 0, amb.out);
  // las variables secretas del sitio que el entorno de quien instala pudiera tener puestas NO viajan a la instancia demo
  const uno = alta(['--apply', '--phase', 'demo'], { config: CONFIG_DEMO(), fix: amb.fix });
  assert.strictEqual(uno.status, 0, uno.out);
  sinMarcadores(uno.out, 'la salida de la fase demo');
  const nuevas = uno.llamadas.slice(amb.llamadas.length);
  for (const l of nuevas) sinMarcadores(`${l.args.join(' ')} ${Object.values(l.archivos).join(' ')}`, 'una orden de az o su archivo');
  assert.ok(!nuevas.some((l) => ['almacen', 'recurso-compartido', 'rol', 'inicio', 'entrada', 'llaves', 'registro'].includes(l.paso)), `ni disco, ni rol, ni candado, ni llaves: ${nuevas.map((l) => l.paso)}`);
  const crea = nuevas.find((l) => l.paso === 'aplicacion' && l.args[1] === 'create');
  assert.ok(crea && crea.args.includes('--yaml'), 'crea la aplicación con su archivo');
  const y = JSON.parse(Object.values(crea.archivos)[0]);
  const cont = y.properties.template.containers[0];
  assert.deepStrictEqual(cont.env.map((e) => [e.name, e.value !== undefined]), [['SITE_DEMO', true], ['SITE_PUBLIC_URL', true]], 'sólo SITE_DEMO y la dirección pública');
  assert.strictEqual(cont.env.find((e) => e.name === 'SITE_DEMO').value, '1');
  assert.strictEqual(cont.env.find((e) => e.name === 'SITE_PUBLIC_URL').value, 'https://demo-acme.cielo-verde-1a2b3c4d.eastus2.azurecontainerapps.io');
  assert.strictEqual(cont.image, CONFIG_DEMO().image);
  assert.deepStrictEqual(y.properties.template.scale, { minReplicas: 0, maxReplicas: 1 }, 'escala a cero');
  assert.strictEqual(y.properties.configuration.ingress.external, true, 'abierta con un link');
  assert.strictEqual(y.properties.configuration.ingress.allowInsecure, false, 'sólo HTTPS');
  assert.strictEqual(y.properties.configuration.secrets, undefined, 'sin secretos');
  assert.strictEqual(y.identity, undefined, 'sin identidad administrada');
  assert.strictEqual(y.properties.template.volumes, undefined, 'sin disco');
  assert.strictEqual(cont.volumeMounts, undefined);
  assert.ok(cont.probes.every((p) => p.httpGet.path === '/livez'), 'las sondas contra /livez');
  assert.match(uno.out, /https:\/\/demo-acme\.cielo-verde-1a2b3c4d\.eastus2\.azurecontainerapps\.io/, 'dice el link');

  // (4) repetida sobre una instancia demo que ya existe: la actualiza (no crea otra) con la imagen de hoy
  const nueva = `ghcr.io/acme/arnes@sha256:${'b'.repeat(64)}`;
  const dos = alta(['--apply', '--phase', 'demo'], { config: { ...CONFIG_DEMO(), image: nueva }, fix: amb.fix });
  assert.strictEqual(dos.status, 0, dos.out);
  const otras = dos.llamadas.slice(uno.llamadas.length);
  assert.ok(!otras.some((l) => l.paso === 'aplicacion' && l.args[1] === 'create'), 'no crea otra aplicación');
  const upd = otras.find((l) => l.paso === 'aplicacion' && l.args[1] === 'update' && l.args.includes('--yaml'));
  assert.ok(upd, 'la actualiza');
  assert.strictEqual(JSON.parse(Object.values(upd.archivos)[0]).properties.template.containers[0].image, nueva);
  assert.match(dos.out, /La aplicación ya existe: se actualiza\./);
  assert.match(dos.out, /imagen: ghcr\.io\/acme\/arnes@sha256:a{64} → ghcr\.io\/acme\/arnes@sha256:b{64}/);

  // (5) un paso que falla: se detiene, dice cuál y qué quedó, y volver a correrla lo completa
  const amb2 = alta(['--apply', '--phase', 'ambiente'], { config: CONFIG_DEMO(), env: {} });
  const falla = alta(['--apply', '--phase', 'demo'], { config: CONFIG_DEMO(), fix: amb2.fix, fixEnv: { TYCON_AZ_FAIL: 'aplicacion:create' } });
  assert.strictEqual(falla.status, 1, falla.out);
  assert.match(falla.out, /falló: crear la aplicación del sitio demo/, 'dice qué paso falló');
  assert.match(falla.out, /Lo que quedó creado: nada/, 'y qué quedó');
  assert.match(falla.out, /corré la fase de nuevo/i);
  const completa = alta(['--apply', '--phase', 'demo'], { config: CONFIG_DEMO(), fix: amb2.fix });
  assert.strictEqual(completa.status, 0, completa.out);
  assert.ok(completa.llamadas.slice(falla.llamadas.length).some((l) => l.paso === 'aplicacion' && l.args[1] === 'create'), 'la segunda corrida crea lo que faltaba');

  // (6) nunca pisa una aplicación que no es una instancia demo (la de la organización, con el mismo nombre)
  const amb3 = alta(['--apply', '--phase', 'ambiente']);
  const sitioReal = alta(['--apply', '--phase', 'sitio'], { fix: amb3.fix });
  assert.strictEqual(sitioReal.status, 0, sitioReal.out);
  const pisar = alta(['--apply', '--phase', 'demo'], { config: { ...CONFIG_DEMO(), resourceGroup: CONFIG().resourceGroup, environment: CONFIG().environment, app: CONFIG().app, logAnalyticsWorkspace: CONFIG().logAnalyticsWorkspace }, fix: amb3.fix });
  assert.strictEqual(pisar.status, 1, pisar.out);
  assert.match(pisar.out, /no es una instancia demo/);
  assert.ok(!pisar.llamadas.slice(sitioReal.llamadas.length).some((l) => l.paso === 'aplicacion' && ['create', 'update'].includes(l.args[1])), 'no la toca');
});
