#!/usr/bin/env node
'use strict';
/**
 * update-site.js — mantiene el sitio de la organización al día con `stable`, con la herramienta de cada entorno.
 *
 * Lo mismo en todas las plataformas: resuelve `stable` en el registro (sin credenciales, latest-release.js), lo compara
 * con lo que corre y decide:
 *   · `al_dia`       la misma huella, o lo que corre es más nuevo (nunca se baja de versión: alguien pudo instalar una
 *                    versión más nueva a mano);
 *   · `aviso`        en «sólo aviso» (`site.update: "notice"`, o sin la clave): registra y no toca nada;
 *   · `no_pudo`      `stable` es una huella que ya volvió atrás (no se reintenta hasta que `stable` se mueva), o falló
 *                    algo antes de cambiar (sin red, sin permiso, sin el hook de Render);
 *   · `actualizado`  en automático: cambió la imagen POR HUELLA y la prueba pasó;
 *   · `vuelto_atras` la prueba falló: volvió a la huella anterior y la probó otra vez;
 *   · `pedido`       Render: el redespliegue se pidió (Render lo hace de fondo; la prueba es la de la noche siguiente).
 * «Arranca sana» lo prueba esto, no se supone: después de cambiar la imagen despierta el sitio y le corre la prueba sin
 * sesión (check-deploy.js), que espera a que despierte.
 *
 * Plataformas: `azure` (Container Apps, con la sesión de `az` del nocturno: `containerapp show` y `update --image`),
 * `render` (el hook de redespliegue con `imgURL=<imagen>@<huella>`; el hook es un secreto y nunca sale en la salida) y
 * `local` (`docker compose pull` y `up -d` con `SITE_IMAGE=<imagen>@<huella>`).
 *
 * El resultado se escribe en `<estadoDir>/site-update-<día>.json` (lo guarda el nocturno en los datos de operaciones y lo
 * lee el resumen de la mañana): sólo estado, versiones, hora y un motivo de la lista cerrada; ninguna dirección, grupo,
 * aplicación ni hook. Lo que hace falta recordar entre noches (las huellas que fallaron y lo aplicado en Render) va en
 * `<estadoDir>/site-update-estado.json`.
 *
 * Uso:
 *   node update-site.js --platform azure --resource-group <g> --app <a> --site-url <https://…> --image <registro/repo>
 *                       --operations-json <operations.json> --state-dir <carpeta> [--subscription <s>] [--dry-run]
 *   node update-site.js --platform render --image <registro/repo> --operations-json <…> --state-dir <…>  (el hook, en
 *                       la variable SITE_RENDER_DEPLOY_HOOK)
 *   node update-site.js --platform local --compose <compose.yaml> --site-url http://127.0.0.1:8080 --image <…> --mode auto
 *   SALIDA: 0 al_dia, aviso, actualizado o pedido · 1 no_pudo o vuelto_atras · 2 uso. `TYCON_AZ_CMD` y `TYCON_DOCKER_CMD`
 *   cambian los ejecutables (las pruebas usan dobles).
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const LR = require('../latest-release.js');
const { compare: compararVersiones } = require('../../setup/harness/version-order.js');

const RESULTADOS = Object.freeze(['al_dia', 'aviso', 'actualizado', 'vuelto_atras', 'no_pudo', 'pedido']);
// los motivos que puede llevar un resultado (el comienzo del texto; lo que sigue es un dato de la lista o una versión)
const MOTIVOS = Object.freeze([
  'no se pudo leer stable',
  'no se pudo leer la imagen que corre',
  'no se sabe qué versión corre',
  'no se pudo cambiar la imagen',
  'la prueba sin sesión falló',
  'la huella de stable ya volvió atrás',
  'falta el hook de Render',
  'Render rechazó la imagen: tiene que ser del mismo registro y nombre',
  'Render no aceptó el pedido',
  'plataforma desconocida',
  'no se pudo leer site.update',
  'no se pudieron comparar las versiones',
  'la imagen que corre cambió durante la ejecución',
  'no se pudo leer el estado del actualizador',
]);
const HUELLA = /^sha256:[0-9a-f]{64}$/;

const dia = (t) => new Date(t).toISOString().slice(0, 10);
/** Lo que recuerda el actualizador. Sin el archivo, vacío; un archivo que no se lee es `ilegible` (y no se pisa). */
function leerEstado(dir) {
  let t;
  try { t = fs.readFileSync(path.join(dir, 'site-update-estado.json'), 'utf8'); } catch (e) { return e && e.code === 'ENOENT' ? { fallidas: {}, aplicada: null } : { ilegible: true, fallidas: {}, aplicada: null }; }
  try { const e = JSON.parse(t); return e && typeof e === 'object' && !Array.isArray(e) ? { fallidas: e.fallidas || {}, aplicada: e.aplicada || null } : { ilegible: true, fallidas: {}, aplicada: null }; }
  catch { return { ilegible: true, fallidas: {}, aplicada: null }; }
}
function escribir(dir, nombre, obj, log) {
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, nombre), `${JSON.stringify(obj, null, 2)}\n`); }
  catch (e) { log(`no se pudo escribir ${nombre} (${e.code || e.message})`); }
}
/** `imagen@sha256:…` → la huella; otra forma → null. */
const huellaDe = (ref) => { const m = /@(sha256:[0-9a-f]{64})$/.exec(String(ref || '').trim()); return m ? m[1] : null; };
// 🔴 lo que dice az, docker o Render (puede nombrar el grupo, la aplicación, la suscripción o una dirección) va al registro
//    del proceso, nunca al resultado que se guarda en operaciones: el motivo lleva sólo el código
const breve = (r) => (!r ? 'sin respuesta' : r.error ? (r.error.code || 'no se pudo correr') : `salió ${r.status}`);
const ultimaLinea = (r) => String((r && (r.stderr || r.stdout)) || (r && r.error && r.error.message) || '').trim().split('\n').slice(-1)[0].slice(0, 300);

function correrDe(cmd) {
  return (args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 600000, ...opts });
}

/** La prueba de verdad: la prueba sin sesión (check-deploy.js) contra la dirección del sitio (despierta y espera). */
function probarDe() {
  return async (url) => {
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'check-deploy.js'), '--url', url, '--wake-timeout', '180'], { encoding: 'utf8', windowsHide: true, timeout: 300000 });
    return r.status === 0 ? { ok: true } : { ok: false, motivo: `la prueba sin sesión falló (${breve(r)})` };
  };
}

/**
 * Lo que corre, cómo cambiarlo y cómo volver, por plataforma: `{ actual() → { huella } | { error }, aplicar(ref) →
 * { ok } | { error }, url }`. Render no sabe lo que corre: usa lo último que pidió (el estado).
 */
function plataformaDe(o) {
  const conRegistro = (base) => (args, opts) => {
    const res = base(args, opts);
    if (!res || res.status !== 0) (o.log || (() => {}))(`${args.slice(0, 2).join(' ')}: ${ultimaLinea(res)}`);
    return res;
  };
  if (o.plataforma === 'azure') {
    const a = o.azure || {};
    const sub = a.suscripcion ? ['--subscription', a.suscripcion] : [];
    const correr = conRegistro(o.correr || correrDe(process.env.TYCON_AZ_CMD || 'az'));
    return {
      url: a.url,
      actual() {
        const r = correr(['containerapp', 'show', '-g', a.grupo, '-n', a.app, '--query', 'properties.template.containers[0].image', '-o', 'tsv', ...sub]);
        const h = r && r.status === 0 ? huellaDe(r.stdout) : null;
        return h ? { huella: h } : { error: `no se pudo leer la imagen que corre (${r && r.status === 0 ? 'no está fijada por huella' : breve(r)})` };
      },
      aplicar(ref) {
        const r = correr(['containerapp', 'update', '-g', a.grupo, '-n', a.app, '--image', ref, '-o', 'none', ...sub]);
        return r && r.status === 0 ? { ok: true } : { error: `no se pudo cambiar la imagen (${breve(r)})` };
      },
      // `update` vuelve antes de que la revisión nueva sirva: probar antes le pega a la anterior, que todavía tiene el
      // tráfico. Se espera a que la última revisión sea la lista, tenga esa imagen y se lleve todo el tráfico.
      async esperar(ref) {
        const { cadaMs = 10000, plazoMs = 600000, dormir = (ms) => new Promise((r) => setTimeout(r, ms)) } = a.espera || {};
        const hasta = Date.now() + plazoMs;
        for (;;) {
          const r = correr(['containerapp', 'show', '-g', a.grupo, '-n', a.app, '--query', '{ultima:properties.latestRevisionName,lista:properties.latestReadyRevisionName,trafico:properties.configuration.ingress.traffic}', '-o', 'json', ...sub]);
          let v = null;
          try { v = r && r.status === 0 ? JSON.parse(r.stdout) : null; } catch { v = null; }
          if (v && v.ultima && v.ultima === v.lista) {
            const t = Array.isArray(v.trafico) ? v.trafico : [];
            const todo = t.length === 1 && Number(t[0].weight) === 100 && (t[0].latestRevision === true || t[0].revisionName === v.ultima);
            const rv = todo ? correr(['containerapp', 'revision', 'show', '-g', a.grupo, '-n', a.app, '--revision', v.ultima, '--query', '{imagen:properties.template.containers[0].image,estado:properties.runningState}', '-o', 'json', ...sub]) : null;
            let d = null;
            try { d = rv && rv.status === 0 ? JSON.parse(rv.stdout) : null; } catch { d = null; }
            if (d && String(d.imagen).trim() === ref) return { ok: true };
          }
          if (Date.now() >= hasta) return { error: 'la revisión nueva no quedó lista con todo el tráfico' };
          await dormir(cadaMs);
        }
      },
    };
  }
  if (o.plataforma === 'local') {
    const l = o.local || {};
    const correr = conRegistro(o.correr || correrDe(process.env.TYCON_DOCKER_CMD || 'docker'));
    return {
      url: l.url || 'http://127.0.0.1:8080',
      actual() {
        const ps = correr(['compose', '-f', l.compose, 'ps', '-q', 'sitio']);
        const id = ps && ps.status === 0 ? String(ps.stdout).trim().split('\n')[0] : '';
        if (!id) return { error: `no se pudo leer la imagen que corre (${ps && ps.status === 0 ? 'el contenedor no corre' : breve(ps)})` };
        const r = correr(['inspect', '--format', '{{.Config.Image}}', id]);
        const h = r && r.status === 0 ? huellaDe(r.stdout) : null;
        return h ? { huella: h } : { error: `no se pudo leer la imagen que corre (${r && r.status === 0 ? 'no está fijada por huella' : breve(r)})` };
      },
      aplicar(ref) {
        const env = { ...process.env, SITE_IMAGE: ref };
        for (const args of [['compose', '-f', l.compose, 'pull', 'sitio'], ['compose', '-f', l.compose, 'up', '-d', 'sitio']]) {
          const r = correr(args, { env });
          if (!r || r.status !== 0) return { error: `no se pudo cambiar la imagen (${breve(r)})` };
        }
        return { ok: true };
      },
    };
  }
  return null;
}

/** El hook de Render: `imgURL` por huella. La dirección del hook no se escribe en ningún lado. */
async function pedirRender(hook, ref, f = globalThis.fetch) {
  let u;
  try { u = new URL(hook); } catch { return { error: 'falta el hook de Render' }; }
  // el hook lleva su llave en la dirección: nunca por http, salvo un servidor local de las pruebas
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname))) return { error: 'falta el hook de Render' };
  u.searchParams.set('imgURL', ref);
  try {
    const r = await f(u.toString(), { method: 'POST' });
    if (r.ok) return { ok: true };
    if (r.status === 404) return { error: 'Render rechazó la imagen: tiene que ser del mismo registro y nombre' };
    return { error: `Render no aceptó el pedido (${r.status})` };
  } catch (e) {
    return { error: `Render no aceptó el pedido (${(e.cause && e.cause.code) || 'sin red'})` };
  }
}

/** Decide y aplica. Devuelve el resultado (y lo escribe en `estadoDir`). Nunca rechaza. */
async function actualizar(o) {
  const { plataforma, imagen, estadoDir, ahora = Date.now, log = () => {}, urlRegistro = null, fetch: f } = o;
  const modo = o.modo === 'auto' ? 'auto' : 'notice';
  const estado = estadoDir ? leerEstado(estadoDir) : { fallidas: {}, aplicada: null };
  const hora = new Date(ahora()).toISOString();
  const fin = (resultado, desde, hacia, motivo = null) => {
    const r = { version: 1, plataforma, resultado, desde: desde || null, hacia: hacia || null, hora, motivo };
    if (estadoDir) { escribir(estadoDir, `site-update-${dia(ahora())}.json`, r, log); if (!estado.ilegible) escribir(estadoDir, 'site-update-estado.json', estado, log); }
    log(`sitio: ${resultado}${desde || hacia ? ` (${desde || '?'} → ${hacia || '?'})` : ''}${motivo ? `: ${motivo}` : ''}`);
    return r;
  };

  // un modo que no se pudo leer (operations.json ilegible, o un site.update que no vale) no es «sólo aviso»: se dice
  if (o.modo === null) return fin('no_pudo', null, null, 'no se pudo leer site.update');
  // sin saber qué huellas ya volvieron atrás, no se instala nada (se podría reintentar una mala): se dice y no se pisa
  if (estado.ilegible) { log('site-update-estado.json no se pudo leer: no se toca nada hasta arreglarlo'); return fin('no_pudo', null, null, 'no se pudo leer el estado del actualizador'); }
  const st = await LR.consultar({ imagen, etiqueta: 'stable', urlBase: urlRegistro, fetch: f });
  if (!st.ok || !HUELLA.test(String(st.huella))) return fin('no_pudo', null, null, `no se pudo leer stable (${st.ok ? 'sin huella' : st.motivo})`);
  const nombre = LR.nombreSinEtiqueta(imagen);
  const ref = `${nombre}@${st.huella}`;

  // Render: no se puede preguntar qué corre sin una credencial de su API; vale lo último que se le pidió
  if (plataforma === 'render') {
    const prev = estado.aplicada;
    if (prev && prev.huella === st.huella) {
      // lo pedido la noche anterior se prueba ahora (Render redespliega de fondo): «al día» sólo si el sitio contesta sano
      if (o.render && o.render.url) {
        const pr = await (o.probar || probarDe())(o.render.url);
        if (!pr.ok) return fin('no_pudo', prev.version, st.version, 'la prueba sin sesión falló');
      }
      return fin('al_dia', prev.version, st.version);
    }
    const cr = prev ? compararVersiones(prev.version, st.version) : -1;
    if (cr === null) return fin('no_pudo', prev.version, st.version, 'no se pudieron comparar las versiones');
    if (cr >= 0) return fin('al_dia', prev.version, st.version);
    if (modo !== 'auto') return fin('aviso', prev && prev.version, st.version);
    const hook = o.render && o.render.hook;
    if (!hook) return fin('no_pudo', prev && prev.version, st.version, 'falta el hook de Render');
    const p = await pedirRender(hook, ref, f);
    if (p.error) return fin('no_pudo', prev && prev.version, st.version, p.error);
    estado.aplicada = { huella: st.huella, version: st.version };
    return fin('pedido', prev && prev.version, st.version);
  }

  const p = plataformaDe(o);
  if (!p) return fin('no_pudo', null, st.version, `plataforma desconocida (${plataforma})`);
  const a = p.actual();
  if (a.error) return fin('no_pudo', null, st.version, a.error);
  const cv = await LR.consultar({ imagen, etiqueta: a.huella, urlBase: urlRegistro, fetch: f });
  const desde = cv.ok ? cv.version : null;
  if (a.huella === st.huella) return fin('al_dia', desde, st.version);
  // 🔴 nunca se baja: sin saber qué versión corre, o con versiones que no se pueden comparar, no se instala nada
  if (!desde) return fin(modo === 'auto' ? 'no_pudo' : 'aviso', null, st.version, modo === 'auto' ? 'no se sabe qué versión corre: la imagen que corre no trae su versión en el registro; la primera actualización va a mano' : null);
  const cmp = compararVersiones(desde, st.version);
  if (cmp === null) return fin('no_pudo', desde, st.version, 'no se pudieron comparar las versiones');
  if (cmp >= 0) return fin('al_dia', desde, st.version);
  if (estado.fallidas[st.huella]) return fin('no_pudo', desde, st.version, `la huella de stable ya volvió atrás: ${estado.fallidas[st.huella]}`);
  if (modo !== 'auto') return fin('aviso', desde, st.version);
  if (o.dryRun) return fin('aviso', desde, st.version);

  // la máquina propia se prueba por /livez en la dirección local (la prueba sin sesión pide https y un candado delante)
  const probar = o.probar || (plataforma === 'local' ? probarLocal() : probarDe());
  // dos corridas a la vez: si la imagen que corre cambió desde que se miró (otra la actualizó), ésta no toca nada
  const otraVez = p.actual();
  if (otraVez.error || otraVez.huella !== a.huella) return fin('no_pudo', desde, st.version, 'la imagen que corre cambió durante la ejecución');
  const anterior = `${nombre}@${a.huella}`;
  const cambio = p.aplicar(ref);
  if (cambio.error) {
    // un cambio a medias (en una máquina propia, el pull bien y el up mal) vuelve a la anterior y no se reintenta
    estado.fallidas[st.huella] = cambio.error;
    const atras = p.aplicar(anterior);
    return fin('no_pudo', desde, st.version, atras.error ? `${cambio.error}; y ${atras.error}` : cambio.error);
  }
  const lista = p.esperar ? await p.esperar(ref) : { ok: true };
  const prueba = lista.error ? { ok: false, motivo: `la prueba sin sesión falló (${lista.error})` } : await probar(p.url);
  if (prueba.ok) return fin('actualizado', desde, st.version);
  // la prueba falló: vuelve a la huella que corría y la prueba otra vez; la huella nueva no se reintenta
  const motivo = prueba.motivo && prueba.motivo.startsWith('la prueba sin sesión falló') ? prueba.motivo : `la prueba sin sesión falló (${prueba.motivo || 'sin motivo'})`;
  estado.fallidas[st.huella] = motivo;
  const atras = p.aplicar(anterior);
  if (atras.error) return fin('no_pudo', desde, st.version, `${motivo}; y ${atras.error}`);
  const devuelta = p.esperar ? await p.esperar(anterior) : { ok: true };
  const otra = devuelta.error ? { ok: false } : await probar(p.url);
  return fin('vuelto_atras', desde, st.version, otra.ok ? motivo : `${motivo}; la anterior tampoco pasó la prueba`);
}

// ── el sitio de prueba local (lo que `harness.js update` hace después de aplicar) ──────────────────────────────────
/** `/livez` de la dirección local, con espera: el contenedor recién recreado tarda unos segundos en contestar. */
function probarLocal(intentos = 30) {
  return async (url) => {
    for (let i = 0; i < intentos; i++) {
      try { const r = await fetch(`${url.replace(/\/$/, '')}/livez`); if (r.ok) return { ok: true }; } catch { /* todavía no contesta */ }
      await new Promise((ok) => setTimeout(ok, 1000));
    }
    return { ok: false, motivo: 'la prueba sin sesión falló (/livez no contestó)' };
  };
}

/**
 * Las líneas que `harness.js update` muestra sobre el sitio de prueba local. Reconoce el sitio por sus ETIQUETAS (nunca
 * lee el ambiente de los contenedores de quien corre esto): `tycon.image=site`, la de la imagen del sitio, y
 * `tycon.site=local`, la que pone compose.yaml. Con las dos, lo pone al día con `stable`, pero SÓLO si salió del
 * compose.yaml de este arnés (otra ruta, aunque la etiqueta coincida, no se corre). Con la imagen y sin la etiqueta, no lo
 * toca y dice cómo reiniciarlo. Sin Docker o sin el contenedor, nada. Nunca rechaza.
 */
async function sitioDePrueba({ dryRun = false, correr = correrDe(process.env.TYCON_DOCKER_CMD || 'docker'), probar = probarLocal(), urlRegistro = process.env.TYCON_SITE_REGISTRY_URL || null, url = process.env.TYCON_SITE_LOCAL_URL || 'http://127.0.0.1:8080', compose: composeDelArnes = path.join(__dirname, 'local', 'compose.yaml') } = {}) {
  const ps = correr(['ps', '--format', '{{.ID}}']);
  if (!ps || ps.status !== 0) return [];
  const sitios = [];
  for (const id of String(ps.stdout).split('\n').map((x) => x.trim()).filter((x) => /^[0-9a-zA-Z_.-]+$/.test(x))) {
    const r = correr(['inspect', '--format', '{{json .Config.Labels}}', id]);
    let labels = null;
    try { labels = r && r.status === 0 ? JSON.parse(r.stdout) : null; } catch { labels = null; }
    if (labels && (labels['tycon.image'] === 'site' || labels['tycon.site'] === 'local')) sitios.push({ id, labels });
  }
  if (!sitios.length) return [];
  const local = sitios.find((c) => c.labels['tycon.site'] === 'local');
  if (!local) return ['el sitio de prueba corre sin la etiqueta tycon.site=local: para ponerlo al día, volvé a arrancarlo con scripts/site/deploy/local/start.js'];
  const real = (x) => { try { return fs.realpathSync(x); } catch { return null; } };
  const compose = String(local.labels['com.docker.compose.project.config_files'] || '').split(',')[0];
  if (!compose || !real(composeDelArnes) || real(compose) !== real(composeDelArnes)) return ['el sitio de prueba no salió del compose.yaml de este arnés: no se toca (volvé a arrancarlo con scripts/site/deploy/local/start.js)'];
  const img = correr(['inspect', '--format', '{{.Config.Image}}', local.id]);
  const imagen = img && img.status === 0 ? LR.nombreSinEtiqueta(String(img.stdout).trim()) : '';
  if (!LR.partirImagen(imagen)) return ['el sitio de prueba corre una imagen que no se reconoce: no se toca'];
  if (dryRun) return ['el sitio de prueba local se pondría al día con stable (docker compose pull y up -d)'];
  const res = await actualizar({ plataforma: 'local', modo: 'auto', imagen, urlRegistro, local: { compose: real(composeDelArnes), url }, correr, probar });
  if (res.resultado === 'actualizado') return [`sitio de prueba local: ${res.desde || '?'} → ${res.hacia}`];
  if (res.resultado === 'al_dia') return [];
  return [`no se pudo actualizar el sitio de prueba (${(res.motivo || res.resultado).split(' (')[0]})`];
}

/** `site.update` de operations.json: «auto» o «notice» (sin la clave, «notice»); null si no se pudo leer o no vale. */
function modoDe(ruta) {
  let d;
  try { d = JSON.parse(fs.readFileSync(ruta, 'utf8')); } catch { return null; }
  const v = d && d.site ? d.site.update : undefined;
  if (v === undefined) return 'notice';
  return v === 'auto' || v === 'notice' ? v : null;
}

async function main(argv) {
  const op = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  if (argv.includes('--test-site')) {
    for (const l of await sitioDePrueba({ dryRun: argv.includes('--dry-run') })) process.stdout.write(`${l}\n`);
    return 0;
  }
  const plataforma = op('--platform');
  if (!['azure', 'render', 'local'].includes(plataforma) || !op('--image')) {
    process.stderr.write('uso: update-site.js --platform azure|render|local --image <registro/repo> [--operations-json <archivo> | --mode auto|notice] [--state-dir <carpeta>] …\n');
    return 2;
  }
  const modo = op('--mode') ? (['auto', 'notice'].includes(op('--mode')) ? op('--mode') : null) : (op('--operations-json') ? modoDe(op('--operations-json')) : 'notice');
  const r = await actualizar({
    plataforma, modo, imagen: op('--image'), estadoDir: op('--state-dir'), dryRun: argv.includes('--dry-run'),
    log: (l) => process.stdout.write(`[sitio] ${l}\n`),
    azure: { grupo: op('--resource-group'), app: op('--app'), suscripcion: op('--subscription'), url: op('--site-url') },
    render: { hook: process.env.SITE_RENDER_DEPLOY_HOOK || null, url: op('--site-url') },
    local: { compose: op('--compose'), url: op('--site-url') },
  });
  return ['no_pudo', 'vuelto_atras'].includes(r.resultado) ? 1 : 0;
}

module.exports = { actualizar, modoDe, sitioDePrueba, RESULTADOS, MOTIVOS };

if (require.main === module) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { process.stderr.write(`update-site: falló: ${e && e.stack ? e.stack : e}\n`); process.exit(1); });
}
