'use strict';
/**
 * site-platform.js — el sitio de la organización en Google Cloud Run, para el actualizador del sitio
 * (scripts/site/deploy/update-site.js, `--platform cloudrun`). El núcleo lo encuentra por `sitePlatform` del manifiesto.
 *
 * Con la sesión de `gcloud` del nocturno:
 *   · actual()   `run services describe --format json`: la huella de la imagen que corre. Por etiqueta, lo mismo que en
 *                las otras plataformas. Con el tráfico fijado a una revisión no se toca: `services update` crearía una
 *                revisión sin tráfico y la prueba le pegaría a la vieja. Devuelve también el nombre de la imagen sin la
 *                huella: si corre desde un espejo (un repositorio remoto de Artifact Registry), se aplica con ese mismo.
 *   · aplicar()  `run services update --image <ref> --quiet`: cambia sólo la imagen; conserva plazo, variables y secretos.
 *   · esperar()  la última revisión creada es la lista, está Ready, tiene la imagen pedida y se lleva todo el tráfico.
 * Opciones: `--service`, `--region` (obligatorias) y `--project`. `TYCON_GCLOUD_CMD` cambia el ejecutable (las pruebas).
 * Lo que dice gcloud (puede nombrar el proyecto) va al registro del proceso, nunca al resultado: el motivo lleva el código.
 *
 * Casos: scripts/tests/site-update.test.js (A43).
 */

/** `{ url, actual, aplicar, esperar }`, o `{ error }` si faltan opciones. `util` son las piezas del actualizador. */
function plataforma(o, util) {
  const op = o.opciones || {};
  if (!op.service || !op.region) return { error: 'faltan --service y --region' };
  const donde = ['--region', op.region, ...(op.project ? ['--project', op.project] : [])];
  const correr = util.conRegistro(o.correr || util.correrDe(process.env.TYCON_GCLOUD_CMD || 'gcloud'));
  const describir = () => {
    const r = correr(['run', 'services', 'describe', op.service, ...donde, '--format', 'json']);
    let d = null;
    try { d = r && r.status === 0 ? JSON.parse(r.stdout) : null; } catch { d = null; }
    return { r, d };
  };
  const imagenDe = (d) => {
    const c = d && d.spec && d.spec.template && d.spec.template.spec && Array.isArray(d.spec.template.spec.containers) ? d.spec.template.spec.containers[0] : null;
    return String((c && c.image) || '').trim();
  };
  // todo el tráfico a la última revisión: lo que `services update` deja por defecto
  const alUltimo = (t) => Array.isArray(t) && t.length === 1 && Number(t[0].percent) === 100 && t[0].latestRevision === true;
  return {
    url: o.url,
    actual() {
      const { r, d } = describir();
      if (!d) return { error: `no se pudo leer la imagen que corre (${r && r.status === 0 ? 'la respuesta no es JSON' : util.breve(r)})` };
      const img = imagenDe(d);
      const h = util.huellaDe(img);
      if (!h) return { error: util.sinHuella({ stdout: img }) };
      if (!alUltimo(d.spec.traffic)) return { error: 'el tráfico está fijado a una revisión: devolvéselo a la última (services update-traffic --to-latest) para que se actualice solo' };
      return { huella: h, nombre: img.slice(0, img.lastIndexOf('@')) };
    },
    aplicar(ref) {
      const r = correr(['run', 'services', 'update', op.service, '--image', ref, ...donde, '--quiet']);
      return r && r.status === 0 ? { ok: true } : { error: `no se pudo cambiar la imagen (${util.breve(r)})` };
    },
    async esperar(ref) {
      const { cadaMs = 10000, plazoMs = 600000, dormir = (ms) => new Promise((ok) => setTimeout(ok, ms)) } = o.espera || {};
      const hasta = Date.now() + plazoMs;
      for (;;) {
        const { d } = describir();
        const st = d && d.status;
        if (st && st.latestCreatedRevisionName && st.latestCreatedRevisionName === st.latestReadyRevisionName && imagenDe(d) === ref) {
          const t = Array.isArray(st.traffic) ? st.traffic : [];
          const todo = t.length === 1 && Number(t[0].percent) === 100 && t[0].revisionName === st.latestReadyRevisionName;
          const lista = Array.isArray(st.conditions) && st.conditions.some((x) => x && x.type === 'Ready' && x.status === 'True');
          if (todo && lista) return { ok: true };
        }
        if (Date.now() >= hasta) return { error: 'la revisión nueva no quedó lista con todo el tráfico' };
        await dormir(cadaMs);
      }
    },
  };
}

module.exports = { plataforma };
