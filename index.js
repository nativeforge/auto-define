/**
 * @typedef {'pascal' | 'camel' | 'kebab' | 'snake'} NamingConvention
 */

/**
 * @typedef {Object} AutoDefineOptions
 * @property {HTMLElement | string} [root=document.body]
 *   Scope of the DOM to scan for undefined custom elements.
 * @property {string} [path='/components/']
 *   Base path searched for component files. Should be root-relative (e.g. `/components/`)
 *   or an absolute URL. For each discovered tag, the following candidates are tried in order:
 *   1. `{path}/{FileName}.js`
 *   2. `{path}/{tag-name}/{FileName}.js`
 *   3. `{path}/{tag-name}/index.js`
 * @property {NamingConvention} [caseConvention='kebab']
 *   How tag names are transformed when constructing file and class names.
 *   - `'kebab'`  — `my-element` → `my-element` (default)
 *   - `'pascal'` — `my-element` → `MyElement`
 *   - `'camel'`  — `my-element` → `myElement`
 *   - `'snake'`  — `my-element` → `my_element`
 * @property {boolean} [observe=false]
 *   Watch for dynamically added custom elements and define them on the fly.
 *   Use `signal` to disconnect the observer when no longer needed.
 * @property {AbortSignal} [signal]
 *   Disconnect the MutationObserver (only relevant when `observe: true`).
 * @property {boolean} [debug=false]
 *   Log resolution attempts and results to the console.
 */

/**
 * @typedef {Object} AutoDefineResult
 * @property {string[]} resolved - Tags that were successfully imported and defined.
 * @property {string[]} failed   - Tags that could not be resolved or had no usable export.
 */

/**
 * Scans the DOM for undefined custom elements and automatically imports and
 * registers them via `customElements.define()`.
 *
 * For each discovered tag name, the library constructs a file name using the
 * chosen `naming` convention and attempts to import from up to three candidate
 * paths under `path`. If the imported module self-registers (calls
 * `customElements.define` internally), that is respected. Otherwise the
 * module's default export is used as the constructor.
 *
 * @param {AutoDefineOptions} [options={}]
 * @returns {Promise<AutoDefineResult>}
 *
 * @example
 * // Zero-config: scans document.body, looks in /components/, expects kebab-case files
 * const { resolved, failed } = await autoDefine()
 *
 * @example
 * // Custom path and case-convention, with observer
 * const controller = new AbortController()
 * await autoDefine({ path: '/elements/', caseConvention: 'kebab', observe: true, signal: controller.signal })
 * // later: controller.abort()
 */
export async function autoDefine(options = {}) {
  const {
    root = document.body,
    path = '/components/',
    caseConvention = 'kebab',
    observe = false,
    signal,
    debug = false,
  } = options

  if (observe && !signal) {
    console.warn('[autoDefine] observe: true set without a signal — the MutationObserver will never disconnect. Pass an AbortSignal to avoid memory leaks.')
  }

  const basePath = path.endsWith('/') ? path : `${path}/`

  const rootEl =
    typeof root === 'string'
      ? document.querySelector(root)
      : root

  if (!rootEl) {
    throw new Error('[autoDefine] root element not found')
  }

  const getUndefinedTags = () => {
    const seen = new Set()

    for (const el of rootEl.querySelectorAll('*')) {
      const tag = el.tagName.toLowerCase()
      if (tag.includes('-') && !seen.has(tag) && !customElements.get(tag)) {
        seen.add(tag)
      }
    }

    return [...seen]
  }

  const processTag = async (tag) => {
    const fileName = applyNaming(tag, caseConvention)

    const candidates = [
      `${basePath}${fileName}.js`,
      `${basePath}${tag}/${fileName}.js`,
      `${basePath}${tag}/index.js`,
    ]

    let anyImported = false

    for (const candidate of candidates) {
      try {
        if (debug) console.log(`[autoDefine] <${tag}> trying ${candidate}`)

        const mod = await import(/* @vite-ignore */ candidate)

        anyImported = true

        if (customElements.get(tag)) {
          if (debug) console.log(`[autoDefine] <${tag}> self-registered from ${candidate}`)
          return { tag, status: 'resolved' }
        }

        const Ctor = mod.default ?? mod[fileName]

        if (typeof Ctor === 'function') {
          customElements.define(tag, Ctor)
          if (debug) console.log(`[autoDefine] <${tag}> defined from ${candidate}`)
          return { tag, status: 'resolved' }
        }
      } catch {
        // candidate not found — try next
      }
    }

    if (anyImported) {
      console.warn(`[autoDefine] <${tag}> file(s) found under ${basePath} but no usable export (expected default export or named export "${fileName}")`)
    } else {
      console.warn(`[autoDefine] <${tag}> could not be resolved under ${basePath}`)
    }

    return { tag, status: 'failed' }
  }

  const processTags = async () => {
    const tags = getUndefinedTags()
    if (debug && tags.length) {
      console.log('[autoDefine] discovered undefined custom elements:', tags)
    }
    const results = await Promise.all(tags.map(processTag))
    return {
      resolved: results.filter(r => r.status === 'resolved').map(r => r.tag),
      failed:   results.filter(r => r.status === 'failed').map(r => r.tag),
    }
  }

  const result = await processTags()

  if (observe) {
    const containsCustomElement = (n) =>
      (n.tagName?.includes('-')) ||
      Array.from(n.querySelectorAll?.('*') ?? []).some(el => el.tagName.includes('-'))

    const observer = new MutationObserver(async (mutations) => {
      const hasNew = mutations
        .flatMap(m => Array.from(m.addedNodes).filter(n => n.nodeType === 1))
        .some(containsCustomElement)

      if (hasNew) await processTags()
    })

    observer.observe(rootEl, { childList: true, subtree: true })

    signal?.addEventListener('abort', () => observer.disconnect(), { once: true })
  }

  return result
}

/* -------------------- helpers -------------------- */

/**
 * Transform a kebab-case tag name using the given naming convention.
 *
 * @param {string} tag   - kebab-case custom element tag name
 * @param {NamingConvention} caseConvention
 * @returns {string}
 */
function applyNaming(tag, caseConvention) {
  const parts = tag.split('-')

  switch (caseConvention) {
    case 'pascal':
      return parts.map(capitalize).join('')

    case 'camel':
      return parts[0] + parts.slice(1).map(capitalize).join('')

    case 'kebab':
      return tag

    case 'snake':
      return parts.join('_')

    default:
      throw new Error(`[autoDefine] unknown case-convention: "${caseConvention}"`)
  }
}

/**
 * @param {string} word
 * @returns {string}
 */
function capitalize(word) {
  return word.length ? word[0].toUpperCase() + word.slice(1) : word
}
