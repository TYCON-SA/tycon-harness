---
name: esbuild-bundling
description: esbuild bundling patterns for production and development builds. Use when asked about "esbuild", "bundling", "global externals", "plugin-based externals", "CSS inlining", "production vs dev builds", "jsx-runtime", "source maps", "build optimization", or "esbuild plugins".
metadata:
  author: tycon-team
  version: "1.0.0"
  last-updated: "2026-01-25"
  changelog: |
    v1.0.0 - Initial version extracted from the build scripts of a team product's forms
---

# esbuild Bundling Patterns

Complete guide for implementing production and development builds with esbuild, focusing on external dependencies, plugin-based externals, and CSS inlining.

## Core Principles

1. **Two Build Modes** - Production (slim bundle) vs Development (fat bundle)
2. **Plugin-Based Externals** - Use custom plugins for global window.* references
3. **CSS Inlining** - Convert CSS imports to JavaScript for single-file bundles
4. **jsx-runtime Compatibility** - Wrapper functions for signature mismatch
5. **Source Maps** - Always generate for debugging
6. **ESM Format** - Use ES Modules for dynamic import() support

## When to Use This Skill

Use this skill when you need to:
- Build JavaScript/TypeScript bundles with esbuild
- Mark dependencies as external (React, SDK packages)
- Inline CSS into JavaScript bundles
- Create production vs development builds
- Implement global window.* references for externals
- Handle jsx-runtime vs createElement signature differences
- Optimize bundle size with tree-shaking
- Generate metadata files for bundles

## Quick Reference

### Basic esbuild Build

```javascript
const esbuild = require('esbuild');

await esbuild.build({
  entryPoints: ['./src/index.tsx'],
  bundle: true,
  format: 'esm',
  outfile: './dist/form.js',
  platform: 'browser',
  target: ['es2020'],
  minify: true,
  sourcemap: true,
  loader: {
    '.tsx': 'tsx',
    '.ts': 'ts',
    '.css': 'css',
    '.json': 'json'
  }
});
```

### Global Externals Plugin

```javascript
const globalExternalsPlugin = {
  name: 'global-externals',
  setup(build) {
    // Intercept React imports
    build.onResolve({ filter: /^react$/ }, args => {
      return { path: args.path, namespace: 'global-externals' }
    })

    // Return global references
    build.onLoad({ filter: /.*/, namespace: 'global-externals' }, args => {
      if (args.path === 'react') {
        return { contents: 'module.exports = window.React', loader: 'js' };
      }
      // ... other packages
    })
  }
}
```

### CSS Inline Plugin

```javascript
const inlineCSSPlugin = {
  name: 'inline-css',
  setup(build) {
    build.onLoad({ filter: /\.css$/ }, async (args) => {
      const css = await fs.promises.readFile(args.path, 'utf8');
      const escapedCSS = css
        .replace(/\\/g, '\\\\')
        .replace(/`/g, '\\`')
        .replace(/\$/g, '\\$');

      const contents = `
        (function() {
          if (typeof document !== 'undefined') {
            const style = document.createElement('style');
            style.textContent = \`${escapedCSS}\`;
            document.head.appendChild(style);
          }
        })();
      `;
      return { contents, loader: 'js' };
    });
  }
};
```

### jsx-runtime Wrapper

```javascript
// Wrapper to fix jsx-runtime signature mismatch
build.onLoad({ filter: /jsx-runtime/ }, args => {
  return {
    contents: `
      function createElementWithKey(type, props, key) {
        if (key !== undefined && props) {
          props = Object.assign({}, props, { key: key });
        }
        var children = props && props.children;
        delete props.children;
        if (Array.isArray(children)) {
          return window.React.createElement.apply(null, [type, props].concat(children));
        } else if (children !== undefined) {
          return window.React.createElement(type, props, children);
        }
        return window.React.createElement(type, props);
      }
      module.exports = {
        jsx: createElementWithKey,
        jsxs: createElementWithKey,
        Fragment: window.React.Fragment
      };
    `,
    loader: 'js'
  };
});
```

## Two Build Modes

### Production Build (Slim Bundle)

**Purpose:** For deployment to runtime app, marks external dependencies.

**build-form.js:**
```javascript
const esbuild = require('esbuild');

await esbuild.build({
  entryPoints: ['./src/index.tsx'],
  bundle: true,
  format: 'esm',
  outfile: './dist/form.js',
  platform: 'browser',
  target: ['es2020'],
  minify: true,           // ✅ Minified
  sourcemap: true,

  plugins: [
    inlineCSSPlugin,
    globalExternalsPlugin  // React, Bizuit SDK as externals
  ],

  // Banner with metadata
  banner: {
    js: `
/* Bizuit Custom Form: my-form */
/* Built: ${new Date().toISOString()} */
/* React: window.React (external) */

const React = window.React;
const ReactDOM = window.ReactDOM;
    `.trim()
  },

  // Use transform JSX (not jsx-runtime imports)
  jsx: 'transform',
  jsxFactory: 'React.createElement',
  jsxFragment: 'React.Fragment'
});
```

**Output:** `dist/form.js` (~50-100 KB)

**Externals:**
- `react` → `window.React`
- `react-dom` → `window.ReactDOM`
- `@tyconsa/bizuit-form-sdk` → `window.BizuitFormSDK`
- `@tyconsa/bizuit-ui-components` → `window.BizuitUIComponents`

**Bundled:**
- `@microsoft/signalr` (not all forms use it)
- `date-fns` (runtime doesn't expose globally)
- `@sentry/react` (optional)
- All other npm packages

---

### Development Build (Fat Bundle)

**Purpose:** For local testing with `dev.html`, bundles all dependencies except React.

**build-form-dev.js:**
```javascript
await esbuild.build({
  entryPoints: ['./src/index.tsx'],
  bundle: true,
  format: 'esm',
  outfile: './dist/form.dev.js',
  platform: 'browser',
  target: ['es2020'],
  minify: false,          // ❌ Not minified (easier debugging)
  sourcemap: true,

  plugins: [
    inlineCSSPlugin,
    globalReactPlugin  // Only React as external (not Bizuit SDK)
  ],

  jsx: 'transform',
  jsxFactory: 'React.createElement',
  jsxFragment: 'React.Fragment'
});
```

**Output:** `dist/form.dev.js` (~2-3 MB)

**Externals:**
- `react` → `window.React`
- `react-dom` → `window.ReactDOM`

**Bundled:**
- `@tyconsa/bizuit-form-sdk` (fat bundle)
- `@tyconsa/bizuit-ui-components` (fat bundle)
- `@microsoft/signalr`
- `date-fns`
- All other packages

**Why fat bundle?** `dev.html` is a minimal HTML page with only React CDN. Bizuit packages must be included in the bundle for standalone testing.

---

## Global Externals Plugin Pattern

### Why Custom Plugin?

**Problem:** Simple `external: ['react']` in esbuild config doesn't allow injecting `window.React` references.

**Solution:** Custom plugin that:
1. Intercepts import resolution (`onResolve`)
2. Returns global window.* reference (`onLoad`)

### Complete Implementation

```javascript
const globalExternalsPlugin = {
  name: 'global-externals',
  setup(build) {
    // 1. INTERCEPT RESOLVE (mark as external)
    build.onResolve({ filter: /^react$/ }, args => {
      return { path: args.path, namespace: 'global-externals' }
    })

    build.onResolve({ filter: /^react-dom$/ }, args => {
      return { path: args.path, namespace: 'global-externals' }
    })

    build.onResolve({ filter: /^react\/jsx-runtime$/ }, args => {
      return { path: args.path, namespace: 'global-externals' }
    })

    build.onResolve({ filter: /^react\/jsx-dev-runtime$/ }, args => {
      return { path: args.path, namespace: 'global-externals' }
    })

    build.onResolve({ filter: /^@tyconsa\/bizuit-form-sdk$/ }, args => {
      return { path: args.path, namespace: 'global-externals' }
    })

    build.onResolve({ filter: /^@tyconsa\/bizuit-ui-components$/ }, args => {
      return { path: args.path, namespace: 'global-externals' }
    })

    // 2. INJECT GLOBAL REFERENCES (return window.*)
    build.onLoad({ filter: /.*/, namespace: 'global-externals' }, args => {
      if (args.path === 'react') {
        return { contents: 'module.exports = window.React', loader: 'js' };
      }
      if (args.path === 'react-dom') {
        return { contents: 'module.exports = window.ReactDOM', loader: 'js' };
      }
      if (args.path.includes('jsx-runtime')) {
        // jsx-runtime needs wrapper (see section below)
        return {
          contents: `
            function createElementWithKey(type, props, key) {
              if (key !== undefined && props) {
                props = Object.assign({}, props, { key: key });
              }
              var children = props && props.children;
              delete props.children;
              if (Array.isArray(children)) {
                return window.React.createElement.apply(null, [type, props].concat(children));
              } else if (children !== undefined) {
                return window.React.createElement(type, props, children);
              }
              return window.React.createElement(type, props);
            }
            module.exports = {
              jsx: createElementWithKey,
              jsxs: createElementWithKey,
              Fragment: window.React.Fragment
            };
          `,
          loader: 'js'
        };
      }
      if (args.path === '@tyconsa/bizuit-form-sdk') {
        return { contents: 'module.exports = window.BizuitFormSDK', loader: 'js' };
      }
      if (args.path === '@tyconsa/bizuit-ui-components') {
        return { contents: 'module.exports = window.BizuitUIComponents', loader: 'js' };
      }
      // All other packages are bundled (not external)
      return { contents: '', loader: 'js' };
    })
  }
}
```

### Package Decision Logic

**External (via plugin):**
- React packages (avoid "Invalid hook call" from multiple instances)
- Bizuit SDK packages (provided by runtime app)

**Bundled (not external):**
- SignalR (not all forms use it, runtime doesn't provide)
- date-fns (runtime doesn't expose globally)
- Sentry (optional package)

---

## CSS Inlining Plugin

### Why Inline CSS?

**Problem:** Separate CSS files require runtime app to serve them.

**Solution:** Convert CSS to JavaScript that injects `<style>` tag at runtime.

### Implementation

```javascript
const inlineCSSPlugin = {
  name: 'inline-css',
  setup(build) {
    build.onLoad({ filter: /\.css$/ }, async (args) => {
      // 1. Read CSS file
      const css = await fs.promises.readFile(args.path, 'utf8');

      // 2. Escape special characters in template literal
      const escapedCSS = css
        .replace(/\\/g, '\\\\')  // Backslashes
        .replace(/`/g, '\\`')    // Backticks
        .replace(/\$/g, '\\$');  // Dollar signs

      // 3. Generate JavaScript that injects CSS
      const contents = `
        (function() {
          if (typeof document !== 'undefined') {
            const style = document.createElement('style');
            style.textContent = \`${escapedCSS}\`;
            document.head.appendChild(style);
          }
        })();
      `;

      // 4. Return as JavaScript (not CSS)
      return { contents, loader: 'js' };
    });
  }
};
```

### Result

**Before (separate files):**
```
dist/
├── form.js
└── form.css  ← Separate file
```

**After (inlined):**
```
dist/
└── form.js   ← CSS included as <style> injection
```

**Bundle size increase:** ~10-20 KB (acceptable for single-file deployment)

---

## jsx-runtime Signature Mismatch

### The Problem

**jsx-runtime (new API):**
```javascript
jsx(type, { children: "texto", value: 1 }, key)
//                                         ↑ KEY as 3rd argument
```

**React.createElement (classic API):**
```javascript
createElement(type, props, ...children)
//                         ↑ 3rd argument is CHILD, not key!
```

**If you directly map:**
```javascript
// ❌ INCORRECT
module.exports = {
  jsx: window.React.createElement,  // Signatures DON'T MATCH
  jsxs: window.React.createElement
}
```

**Result:** `<option>` shows value (ID) instead of text (children).

### The Solution: Wrapper Function

```javascript
function createElementWithKey(type, props, key) {
  // 1. If key is provided, merge into props.key
  if (key !== undefined && props) {
    props = Object.assign({}, props, { key: key });
  }

  // 2. Extract children from props (jsx-runtime puts children in props)
  var children = props && props.children;
  delete props.children;

  // 3. Call React.createElement with correct signature
  if (Array.isArray(children)) {
    return window.React.createElement.apply(null, [type, props].concat(children));
  } else if (children !== undefined) {
    return window.React.createElement(type, props, children);
  }
  return window.React.createElement(type, props);
}

module.exports = {
  jsx: createElementWithKey,
  jsxs: createElementWithKey,
  Fragment: window.React.Fragment
};
```

**Why it works:**
- jsx-runtime calls `jsx(type, { children, value }, key)`
- Wrapper extracts `key` and merges into `props.key`
- Wrapper extracts `children` from props (jsx-runtime behavior)
- Wrapper calls `createElement(type, props, children)` (classic API)

---

## Banner and Metadata

### Build Banner (Production)

```javascript
banner: {
  js: `
/* Bizuit Custom Form: ${formName} */
/* Built: ${new Date().toISOString()} */
/* React: window.React (external) */
/* ReactDOM: window.ReactDOM (external) */

// Use global React from runtime app
const React = window.React;
const ReactDOM = window.ReactDOM;
  `.trim()
}
```

**Purpose:**
- Document build metadata
- Provide global React references for convenience
- Help debugging with build timestamp

### Metadata File

```javascript
const metadata = {
  formName: 'my-form',
  version: '1.0.0',
  builtAt: new Date().toISOString(),
  sizeBytes: 52431,
  entryPoint: './src/index.tsx',
  externals: [
    'react',
    'react-dom',
    '@tyconsa/bizuit-form-sdk',
    '@tyconsa/bizuit-ui-components'
  ]
};

fs.writeFileSync('dist/form.meta.json', JSON.stringify(metadata, null, 2));
```

**Output:** `dist/form.meta.json`

```json
{
  "formName": "my-form",
  "version": "1.0.0",
  "builtAt": "2026-01-25T12:34:56.789Z",
  "sizeBytes": 52431,
  "entryPoint": "./src/index.tsx",
  "externals": [
    "react",
    "react-dom",
    "@tyconsa/bizuit-form-sdk",
    "@tyconsa/bizuit-ui-components"
  ]
}
```

**Use cases:**
- Runtime app validates externals match available globals
- Debugging (which version was deployed?)
- Bundle size tracking over time

---

## Build Script Pattern

### Complete build-form.js

```javascript
#!/usr/bin/env node

const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const config = {
  entryPoint: process.argv[2] || './src/index.tsx',
  outfile: process.argv[3] || './dist/form.js',
  formName: process.argv[4] || 'custom-form'
};

console.log('🔨 Building Bizuit Custom Form...');
console.log(`📄 Entry: ${config.entryPoint}`);
console.log(`📦 Output: ${config.outfile}`);
console.log(`🏷️  Name: ${config.formName}`);

async function buildForm() {
  try {
    // Ensure dist directory exists
    const distDir = path.dirname(config.outfile);
    if (!fs.existsSync(distDir)) {
      fs.mkdirSync(distDir, { recursive: true });
    }

    // Plugins (inlineCSSPlugin, globalExternalsPlugin)
    // ... (see above sections)

    const result = await esbuild.build({
      entryPoints: [config.entryPoint],
      bundle: true,
      format: 'esm',
      outfile: config.outfile,
      platform: 'browser',
      target: ['es2020'],
      minify: true,
      sourcemap: true,
      plugins: [inlineCSSPlugin, globalExternalsPlugin],
      banner: { js: '...' },
      jsx: 'transform',
      jsxFactory: 'React.createElement',
      jsxFragment: 'React.Fragment',
      loader: {
        '.tsx': 'tsx',
        '.ts': 'ts',
        '.jsx': 'jsx',
        '.js': 'js',
        '.css': 'css',
        '.json': 'json'
      },
      logLevel: 'info'
    });

    // Get output file size
    const stats = fs.statSync(config.outfile);
    const sizeKB = (stats.size / 1024).toFixed(2);

    console.log('✅ Build successful!');
    console.log(`📊 Size: ${sizeKB} KB`);

    if (result.warnings.length > 0) {
      console.warn('⚠️  Warnings:');
      result.warnings.forEach(warning => console.warn(warning));
    }

    // Create metadata file
    const metadata = { /* ... */ };
    const metadataPath = config.outfile.replace('.js', '.meta.json');
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
    console.log(`📝 Metadata: ${metadataPath}`);

    return { success: true, metadata };

  } catch (error) {
    console.error('❌ Build failed:');
    console.error(error);
    process.exit(1);
  }
}

buildForm();
```

### Usage

```bash
# <forms-repo> = the root of your forms repo (the build scripts come with the public forms template)
# Production build (default)
node <forms-repo>/build-form.js

# Custom entry/output
node <forms-repo>/build-form.js ./src/custom.tsx ./dist/custom.js my-custom-form

# Development build (fat bundle)
node <forms-repo>/build-form-dev.js
```

---

## Common Patterns

### Pattern 1: Multiple Externals

```javascript
const EXTERNALS = {
  'react': 'window.React',
  'react-dom': 'window.ReactDOM',
  '@tyconsa/bizuit-form-sdk': 'window.BizuitFormSDK',
  '@tyconsa/bizuit-ui-components': 'window.BizuitUIComponents'
};

build.onLoad({ filter: /.*/, namespace: 'global-externals' }, args => {
  const globalRef = EXTERNALS[args.path];
  if (globalRef) {
    return { contents: `module.exports = ${globalRef}`, loader: 'js' };
  }
  return { contents: '', loader: 'js' };
});
```

### Pattern 2: Conditional Minification

```javascript
const isProduction = process.env.NODE_ENV === 'production';

await esbuild.build({
  // ...
  minify: isProduction,
  sourcemap: true, // Always generate sourcemaps
  logLevel: isProduction ? 'warning' : 'info'
});
```

### Pattern 3: Watch Mode

```javascript
if (process.argv.includes('--watch')) {
  const context = await esbuild.context({
    // ... build config
  });

  await context.watch();
  console.log('👀 Watching for changes...');
} else {
  await esbuild.build({
    // ... build config
  });
}
```

---

## Common Mistakes

### ❌ Mistake 1: Using simple external array

```javascript
// WRONG - can't inject window.* references
await esbuild.build({
  external: ['react', 'react-dom'],  // Doesn't work!
  // ...
});
```

✅ **Correct:** Use custom plugin with `onResolve` + `onLoad`.

---

### ❌ Mistake 2: Not escaping CSS in template literal

```javascript
// WRONG - CSS with backticks will break
const contents = `
  const style = document.createElement('style');
  style.textContent = \`${css}\`;  // ← Breaks if css has backticks!
`;
```

✅ **Correct:** Escape backslashes, backticks, and dollar signs.

---

### ❌ Mistake 3: jsx-runtime without wrapper

```javascript
// WRONG - signatures don't match
module.exports = {
  jsx: window.React.createElement,  // BAD
  jsxs: window.React.createElement
};
```

✅ **Correct:** Use `createElementWithKey` wrapper function.

---

## Summary

**Key Takeaways:**
- Use custom plugins for global externals (not simple `external: []`)
- Inline CSS with plugin to avoid separate files
- Implement jsx-runtime wrapper for signature compatibility
- Generate metadata files for runtime validation
- Production: slim bundle (minified, externals)
- Development: fat bundle (unminified, all deps)
- Always generate source maps
- Use ESM format for dynamic import() support
