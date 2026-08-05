/*
 * The core of this plugin was conceived by pi0 and is taken from the following repository:
 * https://github.com/unjs/unbuild/blob/main/src/builder/plugins/cjs.ts
 * license: https://github.com/unjs/unbuild/blob/main/LICENSE
 */

import MagicString from 'magic-string'
import type { SourceMapInput } from 'rollup'
import type { Plugin } from 'vite'

import { supportImportMetaPaths } from '../electron'

const CJSyntaxRe = /__filename|__dirname|require\(|require\.resolve\(/

const CJSShim_normal = `
// -- CommonJS Shims --
import __cjs_url__ from 'node:url';
import __cjs_path__ from 'node:path';
import __cjs_mod__ from 'node:module';
const __filename = __cjs_url__.fileURLToPath(import.meta.url);
const __dirname = __cjs_path__.dirname(__filename);
const require = __cjs_mod__.createRequire(import.meta.url);
`

const CJSShim_node_20_11 = `
// -- CommonJS Shims --
import __cjs_mod__ from 'node:module';
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require = __cjs_mod__.createRequire(import.meta.url);
`

const ESMStaticImportRe =
  /(?<=\s|^|;)import\s*([\s"']*(?<imports>[\p{L}\p{M}\w\t\n\r $*,/{}@.]+)from\s*)?["']\s*(?<specifier>(?<="\s*)[^"]*[^\s"](?=\s*")|(?<='\s*)[^']*[^\s'](?=\s*'))\s*["'][\s;]*/gmu

interface StaticImport {
  end: number
}

/**
 * Replace string/template contents and comments with spaces of the same length.
 * Indices stay aligned with the original source so import-end offsets still apply
 * when injecting the CJS shim.
 *
 * Without this, `import ... from '...'` text embedded in string literals (common
 * in large app bundles that ship schema/SQL/source snippets) is treated as a real
 * static import. Injecting the shim after that false match mid-string corrupts
 * the chunk and can cause bundlers (e.g. Rolldown / Vite 8) to emit an empty entry
 * — see https://github.com/alex8088/electron-vite/issues/906
 */
export function maskNonCode(code: string): string {
  let out = ''
  let i = 0
  const n = code.length
  const spaces = (len: number): string => ' '.repeat(len)

  while (i < n) {
    const c = code[i]!
    const c2 = code[i + 1]

    // line comment
    if (c === '/' && c2 === '/') {
      let j = i + 2
      while (j < n && code[j] !== '\n' && code[j] !== '\r') j++
      out += spaces(j - i)
      i = j
      continue
    }

    // block comment
    if (c === '/' && c2 === '*') {
      let j = i + 2
      while (j + 1 < n && !(code[j] === '*' && code[j + 1] === '/')) j++
      j = Math.min(j + 2, n)
      out += spaces(j - i)
      i = j
      continue
    }

    // single- and double-quoted strings
    if (c === '"' || c === "'") {
      const q = c
      let j = i + 1
      while (j < n) {
        if (code[j] === '\\') {
          j += 2
          continue
        }
        if (code[j] === q) {
          j++
          break
        }
        j++
      }
      out += spaces(j - i)
      i = j
      continue
    }

    // template literals (mask whole span, including ${...} expressions —
    // rare real top-level imports inside interpolations, and safer than
    // re-matching import-like SQL/source embedded in templates)
    if (c === '`') {
      let j = i + 1
      while (j < n) {
        if (code[j] === '\\') {
          j += 2
          continue
        }
        if (code[j] === '`') {
          j++
          break
        }
        j++
      }
      out += spaces(j - i)
      i = j
      continue
    }

    out += c
    i++
  }

  return out
}

function findStaticImports(code: string): StaticImport[] {
  const searchable = maskNonCode(code)
  const matches: StaticImport[] = []
  for (const match of searchable.matchAll(ESMStaticImportRe)) {
    matches.push({ end: (match.index || 0) + match[0].length })
  }
  return matches
}

function hasCjsSyntax(code: string): boolean {
  // Ignore CJS markers that only appear inside strings/comments
  return CJSyntaxRe.test(maskNonCode(code))
}

export default function esmShimPlugin(): Plugin {
  const CJSShim = supportImportMetaPaths() ? CJSShim_node_20_11 : CJSShim_normal

  return {
    name: 'vite:esm-shim',
    apply: 'build',
    enforce: 'post',
    renderChunk(code, _chunk, { format, sourcemap }): { code: string; map?: SourceMapInput } | null {
      if (format === 'es') {
        if (code.includes(CJSShim) || !hasCjsSyntax(code)) {
          return null
        }

        const lastESMImport = findStaticImports(code).pop()
        const indexToAppend = lastESMImport ? lastESMImport.end : 0
        const s = new MagicString(code)
        s.appendRight(indexToAppend, CJSShim)
        return {
          code: s.toString(),
          map: sourcemap ? s.generateMap({ hires: 'boundary' }) : null
        }
      }

      return null
    }
  }
}
