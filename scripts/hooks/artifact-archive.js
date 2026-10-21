#!/usr/bin/env node
/**
 * artifact-archive.js — PostToolUse matcher=Artifact
 *
 * Los artefactos publicados en claude.ai nacen de un HTML que vive en el scratchpad de la
 * sesión — una carpeta temporal que se pierde. Este hook copia el archivo publicado al repo
 * git de la sesión (<raíz>/artifacts/) y mantiene un índice con la URL publicada, para que
 * el entregable viaje versionado con el proyecto y no dependa de la galería de claude.ai.
 *
 * Qué NO hace, a propósito:
 *  - NO commitea (regla #0 de git-commit-conventions: ningún commit sin consentimiento).
 *    Deja el archivo en el working tree y lo dice.
 *  - NO actúa sobre acciones que no publican (read/list/comments/watch/...).
 *  - NO copia si el archivo ya vive dentro del repo (ya es versionable donde está).
 *  - Fail-open total: cualquier duda o error → exit 0 en silencio; un hook que rompe la
 *    publicación de un artefacto es peor que un artefacto sin archivar.
 *
 * Asimetría declarada: la tool Artifact es exclusiva de Claude Code — no hay dirección
 * Codex de este control (ver caso 28 del banco).
 *
 * Off: TYCON_ARTIFACT_ARCHIVE=0
 */
'use strict';
const fs = require('fs');
const path = require('path');

const DEST_DIR = 'artifacts';

function gitRoot(from) {
  let dir = path.resolve(from || process.cwd());
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

// Dos formatos de dirección conviven: el viejo (claude.ai/code/artifact/<uuid>) y el actual
// (claude.ai/artifact/<id alfanumérico>). Reconocer sólo el viejo deja «URL no capturada» en el
// índice y pisa la dirección que ya estaba anotada. La galería
// (claude.ai/code/artifacts, con «s» y sin barra después) no matchea.
const ARTIFACT_URL_RE = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9-]+/;

function firstArtifactUrl(...fuentes) {
  for (const f of fuentes) {
    try {
      const s = typeof f === 'string' ? f : JSON.stringify(f || '');
      const m = s.match(ARTIFACT_URL_RE);
      if (m) return m[0];
    } catch { /* sigue con la próxima fuente */ }
  }
  return null;
}

function updateIndex(destDir, baseName, url) {
  // Una línea por artefacto; republicar reemplaza la línea (misma semántica que la URL fija).
  const indexPath = path.join(destDir, 'README.md');
  const header = '# Artefactos publicados\n\n' +
    'Copias versionadas de los artefactos publicados en claude.ai desde sesiones de este repo\n' +
    '(las escribe el hook `artifact-archive.js` del arnés; el fuente original vive en el\n' +
    'scratchpad temporal de cada sesión y se pierde — esta carpeta es la copia que queda).\n\n';
  const stamp = new Date().toISOString().slice(0, 10);
  let body = '';
  try { body = fs.readFileSync(indexPath, 'utf8'); } catch { body = header; }
  // Sin dirección reconocible, se conserva la que ya estaba anotada: «no la vi» no es «no existe».
  const previa = body.split('\n').find((l) => l.startsWith('- `') && l.includes(`\`${baseName}\``));
  const urlFinal = url || firstArtifactUrl(previa || '');
  const line = `- \`${baseName}\` — ${urlFinal || 'URL no capturada'} — ${stamp}`;
  // Sólo se reemplazan líneas DEL ÍNDICE (empiezan con "- `"): un README curado puede
  // mencionar el mismo archivo en una tabla o en prosa, y eso no se toca.
  const lines = body.split('\n').filter((l) => !(l.startsWith('- `') && l.includes(`\`${baseName}\``)));
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  fs.writeFileSync(indexPath, lines.join('\n') + '\n' + line + '\n');
}

function main() {
  if (process.env.TYCON_ARTIFACT_ARCHIVE === '0') return;
  let payload;
  try { payload = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { return; }
  if (!payload || payload.tool_name !== 'Artifact') return;

  const input = payload.tool_input || {};
  const action = input.action || 'publish';
  if (action !== 'publish') return;
  const src = input.file_path;
  if (!src || typeof src !== 'string') return;
  if (!/\.(html|md)$/i.test(src)) return;
  if (!fs.existsSync(src)) return;

  const root = gitRoot(payload.cwd);
  if (!root) return;
  const resolved = path.resolve(src);
  if (resolved === root || resolved.startsWith(root + path.sep)) return; // ya vive en el repo

  const destDir = path.join(root, DEST_DIR);
  const baseName = path.basename(resolved);
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(resolved, path.join(destDir, baseName));
  updateIndex(destDir, baseName, firstArtifactUrl(payload.tool_response, input.url));

  const rel = path.join(DEST_DIR, baseName);
  process.stdout.write(
    `📦 Artefacto archivado en ${rel} (+ índice en ${DEST_DIR}/README.md). ` +
    `Está en el working tree SIN commitear — commitealo cuando cierres la tarea para que no se pierda.\n`
  );
}

try { main(); } catch { /* fail-open: nunca romper el turno por archivar */ }
process.exit(0);
