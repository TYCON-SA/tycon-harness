#!/usr/bin/env node
'use strict';
/**
 * nightly-model.js — cómo un proceso de la noche elige proveedor y modelo. Lo consume el proceso de la noche que redacta los
 * aprendizajes del equipo.
 *
 * POR QUÉ EXISTE: un proceso de la noche no es la máquina de un dev: no tiene `models.provider` ni sesión, así que
 * «inherit» no quiere decir nada. El modelo sale de `team-repos.json → models.nightly` (`{ provider, level }`) y de la
 * tabla de ese proveedor (la de Anthropic es fija; la de Ollama la carga la organización), con el tope y la lista de
 * permitidos. Cambiar de Ollama a Haiku es elegir Anthropic en la misma fila del sitio: no toca código ni pipeline.
 * Sin configuración, sin modelo, fuera de la lista o sin llave, devuelve un estado y no cae en otro proveedor ni en
 * un modelo por defecto. La llamada al proveedor no es de acá: es de quien lo consume.
 *
 * Uso: node scripts/lib/nightly-model.js --org-config <team-repos.json> [--json]
 * Salidas: 0 listo · 2 no se pudo leer el archivo · 3 sin configurar, sin modelo o fuera de la lista · 4 falta la llave.
 * El JSON trae siempre las mismas nueve claves (CLAVES), con null donde no aplica. El valor de la llave no se imprime.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const MODELS_JS = path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'models.js');

/**
 * El nombre de la variable secreta de cada proveedor de la noche: la crea la organización en el pipeline de la noche
 * y nunca pasa por el perfil. `OLLAMA_API_KEY` es provisorio hasta medirlo contra la documentación de Ollama (P4 de la
 * story): si cambia, se cambia acá.
 */
const NIGHTLY_SECRETS = Object.freeze({ anthropic: 'ANTHROPIC_API_KEY', ollama: 'OLLAMA_API_KEY' });
const CLAVES = ['ok', 'status', 'provider', 'level', 'model', 'capped_from', 'secret', 'warnings', 'message'];
const SALIDA = { ok: 0, unreadable: 2, 'not-configured': 3, 'no-model': 3, 'not-allowed': 3, 'no-secret': 4 };
const DEFAULT_LEVEL = 'economy';

/** Un resultado con las nueve claves, en orden. */
function resultado(campos) {
  const base = { ok: false, status: null, provider: null, level: null, model: null, capped_from: null, secret: null, warnings: [], message: null };
  const r = Object.assign(base, campos);
  return Object.fromEntries(CLAVES.map((k) => [k, r[k]]));
}

/** Una llave presente: con valor, y no el `$(NOMBRE)` que deja Azure DevOps cuando la variable secreta no existe. */
function llavePresente(valor) {
  return typeof valor === 'string' && valor.trim() !== '' && !/^\$\([^)]*\)$/.test(valor.trim());
}

/**
 * El modelo de la noche: `{ ok, status, provider, level, model, capped_from, secret, warnings, message }`.
 * opts: orgConfig (la ruta del `team-repos.json` de la organización) · env (el ambiente donde se busca la llave).
 * `status`: ok · unreadable · not-configured · no-model · not-allowed · no-secret. Nunca tira.
 */
function resolveNightly({ orgConfig, env = process.env } = {}) {
  const M = require(MODELS_JS);
  if (!orgConfig || path.basename(String(orgConfig)) !== 'team-repos.json') {
    return resultado({ status: 'unreadable', message: `no pude leer la configuración de la organización: --org-config tiene que ser un team-repos.json (es ${orgConfig || 'nada'})` });
  }
  const file = path.resolve(String(orgConfig));
  if (!fs.existsSync(file)) return resultado({ status: 'unreadable', message: `no pude leer la configuración de la organización: no existe ${file}` });
  const dir = path.dirname(file);
  // el lector del árbol de la organización; si ese árbol no lo trae, el de este árbol. Uno que está y no carga se dice
  const propio = path.join(dir, 'scripts', 'lib', 'team-repos.js');
  let teamRepos;
  try { teamRepos = require(propio); } catch (e) {
    // (la primera línea nombra el archivo que falta; las siguientes, la cadena de quién lo pidió)
    if (!(e && e.code === 'MODULE_NOT_FOUND' && String(e.message).split('\n')[0].includes(propio))) {
      return resultado({ status: 'unreadable', message: `no pude cargar el lector ${propio} (${String((e && e.message) || e).split('\n')[0]})` });
    }
    teamRepos = require(path.join(ROOT, 'scripts', 'lib', 'team-repos.js'));
  }
  const org = M.readOrgModels({ dir, teamRepos });
  if (org.problem) return resultado({ status: 'unreadable', message: org.problem });
  const data = org.declared ? org.data : null;
  const noche = data && data.nightly && typeof data.nightly === 'object' ? data.nightly : null;
  if (!noche) return resultado({ status: 'not-configured', message: 'sin modelo configurado: la organización no declara models.nightly (se elige en el sitio, en la fila «El proceso de la noche»)' });
  const provider = noche.provider;
  const warnings = [];
  let level = M.isLevel(noche.level) ? noche.level : DEFAULT_LEVEL;
  let cappedFrom = null;
  // el tope antes de traducir: el nivel se recorta y recién después se busca el modelo del proveedor
  const techo = M.ceilingOf(data);
  if (techo) {
    const recortado = M.levelOf(M.capAt(M.modelOf(level), techo));
    if (recortado !== level) {
      warnings.push(`el proceso de la noche en ${level} pasa el tope obligatorio de la organización (${M.levelOf(techo)}): uso ${recortado}`);
      cappedFrom = level;
      level = recortado;
    }
  }
  const avisos = [];
  const r = M.resolveProviderModel({ org: data, provider, level, warnings: avisos });
  const secretEnv = NIGHTLY_SECRETS[provider] || null;
  const base = { provider, level, capped_from: cappedFrom, warnings };
  if (r.outside) return resultado({ ...base, status: 'not-allowed', message: `${r.outside} no está entre los permitidos de ${provider}: la noche no corre (en la noche no hay un modelo del dev a qué caer)` });
  if (!r.model || r.model === M.INHERIT) return resultado({ ...base, status: 'no-model', message: `la tabla de ${provider} no trae modelo para ${level}: cargalo en el sitio (en la noche «inherit» no vale)` });
  const secret = { env: secretEnv, present: llavePresente(env[secretEnv]) };
  if (!secret.present) return resultado({ ...base, model: r.model, secret, status: 'no-secret', message: `falta la llave: la variable secreta ${secretEnv} del pipeline de la noche no está definida` });
  return resultado({ ...base, model: r.model, secret, ok: true, status: 'ok', message: `${provider} · ${r.model} (${level})` });
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--org-config');
  const r = resolveNightly({ orgConfig: i >= 0 ? argv[i + 1] : null, env: process.env });
  if (argv.includes('--json')) process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  else {
    process.stdout.write(`${r.ok ? 'listo' : r.status}: ${r.message}\n`);
    if (r.secret) process.stdout.write(`llave: ${r.secret.env} (${r.secret.present ? 'presente' : 'ausente'})\n`);
    for (const w of r.warnings) process.stdout.write(`aviso: ${w}\n`);
  }
  process.exitCode = SALIDA[r.status];
}

module.exports = { resolveNightly, NIGHTLY_SECRETS, CLAVES };
