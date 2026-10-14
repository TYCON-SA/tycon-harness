'use strict';
// public-git.js — las rutas PÚBLICAS de GitHub con las que una versión bajada mira y baja sin permiso (story 8.34).
//
// ── POR QUÉ ──────────────────────────────────────────────────────────────────────────────────────────────────────
// Sin permiso guardado, la API de GitHub (`api.github.com`) tiene un tope de 60 consultas por hora POR CONEXIÓN, aunque el
// repo sea público: dos máquinas que comparten conexión se quedaban sin consultas y no podían actualizar. Estas rutas no
// cuentan contra ese tope (medido el 2026-10-14 con la API agotada: siguieron contestando y `rate_limit` no se movió):
//   · `https://github.com/<org>/<repo>.git/info/refs?service=git-upload-pack` — lo que lee `git ls-remote`, pero leído
//     por el cliente propio (scripts/lib/http-get.js): el arnés NO exige git. Trae todas las ramas con su commit.
//   · `https://raw.githubusercontent.com/<org>/<repo>/<sha>/version.json` — el número, POR COMMIT (por rama queda 5 min
//     en caché y podría dar un número viejo; por commit no cambia nunca).
//   · `https://codeload.github.com/<org>/<repo>/tar.gz/<sha>` — el comprimido del commit (la API redirigía ahí).
// Con permiso guardado no se usan: el camino es el de la API, como antes (lo pidió el dueño; y un repo privado sólo se
// ve con permiso).
//
// ── LAS BASES ────────────────────────────────────────────────────────────────────────────────────────────────────
// `TYCON_RELEASE_GIT`, `TYCON_RELEASE_RAW` y `TYCON_RELEASE_ARCHIVE` cambian las bases (sólo pruebas: el GitHub de
// juguete, como `TYCON_RELEASE_API`). Salvaguarda: si `TYCON_RELEASE_API` está puesta y `TYCON_RELEASE_GIT` no, NO hay
// rutas públicas (`bases` → null) y se mira por la API como antes: un laboratorio que apuntó la API a su juguete y no
// las rutas públicas no sale al GitHub de verdad. El ensayo contra el GitHub real que apunta la API a un puerto cerrado
// pone `TYCON_RELEASE_GIT=https://github.com` explícito.
//
// ── EL FORMATO DE info/refs ──────────────────────────────────────────────────────────────────────────────────────
// Líneas pkt-line: 4 dígitos hexadecimales con el largo (contándose) y el contenido; `0000` es un corte. La primera es
// `# service=git-upload-pack`, después un corte, y cada ref es `<sha> <nombre>`; la primera lleva las capacidades después
// de un byte nulo.
//
// Sin dependencias; sin `require` fuera de Node al cargar.

const DEFAULTS = { git: 'https://github.com', raw: 'https://raw.githubusercontent.com', codeload: 'https://codeload.github.com' };
const trim = (u) => String(u).replace(/\/+$/, '');

/** Las bases de las rutas públicas, o null si este entorno no las usa (la salvaguarda de las pruebas, arriba). */
function bases(env = process.env) {
  if (env.TYCON_RELEASE_API && !env.TYCON_RELEASE_GIT) return null;
  const out = {
    git: trim(env.TYCON_RELEASE_GIT || DEFAULTS.git),
    raw: trim(env.TYCON_RELEASE_RAW || DEFAULTS.raw),
    codeload: trim(env.TYCON_RELEASE_ARCHIVE || DEFAULTS.codeload),
  };
  return Object.values(out).every((u) => /^https?:\/\//.test(u)) ? out : null;
}

const refsUrl = (b, repo) => `${b.git}/${repo}.git/info/refs?service=git-upload-pack`;
const rawUrl = (b, repo, sha, file) => `${b.raw}/${repo}/${sha}/${file}`;
const tarUrl = (b, repo, sha) => `${b.codeload}/${repo}/tar.gz/${sha}`;

/**
 * Las ramas de una respuesta de `info/refs`: `{ ok: true, heads: { <rama>: <sha> } }` o `{ ok: false, reason }` si no es
 * una respuesta de git (una página de error, un proxy que contestó otra cosa, un corte).
 */
function parseInfoRefs(buf) {
  const text = Buffer.isBuffer(buf) ? buf.toString('latin1') : String(buf || '');
  const lines = [];
  let i = 0;
  while (i < text.length) {
    const len = parseInt(text.slice(i, i + 4), 16);
    if (!/^[0-9a-f]{4}$/i.test(text.slice(i, i + 4)) || Number.isNaN(len)) return { ok: false, reason: `no es una respuesta de git (byte ${i})` };
    if (len === 0) { lines.push(null); i += 4; continue; }
    if (len < 4 || i + len > text.length) return { ok: false, reason: `respuesta de git cortada (byte ${i})` };
    lines.push(text.slice(i + 4, i + len).replace(/\n$/, ''));
    i += len;
  }
  if (lines[0] !== '# service=git-upload-pack') return { ok: false, reason: 'no es una respuesta de git (falta «# service=git-upload-pack»)' };
  if (lines[lines.length - 1] !== null) return { ok: false, reason: 'respuesta de git cortada (sin el corte final)' };
  const heads = {};
  for (const l of lines.slice(1)) {
    if (l === null) continue;
    const m = /^([0-9a-f]{40}) (refs\/heads\/[^\0]+)/.exec(l);
    if (m) heads[m[2].slice('refs/heads/'.length)] = m[1];
  }
  return { ok: true, heads };
}

module.exports = { bases, refsUrl, rawUrl, tarUrl, parseInfoRefs, DEFAULTS };
