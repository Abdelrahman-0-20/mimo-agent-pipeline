/**
 * Fail-soft tool scoping for the thinker child (dsh-plugin-mimo-think).
 *
 * tools.restrict() THROWS when the deny list names a global tool this DSH
 * build does not have (packages/core/tools/src/index.ts rejects unknown
 * names), and one stale name would leave the child completely unsliced.
 * This helper parses the "unknown global tool" error, drops exactly those
 * names, and retries once — a name the harness never heard of costs one
 * denied schema, not the whole scoping pass. Any other error is rethrown so
 * the caller's catch can log it (child left unsliced, never broken).
 */

/** The restrict() unknown-name error shape: names between the marker and the known-list suffix. */
const UNKNOWN_RE = /unknown global tools?\s+([\s\S]*?);\s*known global tools:/

/** Extract the double-quoted tool names from an error-message segment. */
const quotedNames = (segment) => [...segment.matchAll(/"([^"]+)"/g)].map(match => match[1])

/**
 * Apply a deny restriction, dropping names this build does not know.
 * @param {(filter: { deny: string[] }) => (() => void)} restrict - the scoped tools.restrict bound to its context.
 * @param {string[]} deny - desired global-tool deny list.
 * @returns {{ disposer: (() => void) | null, dropped: string[] }}
 *   disposer is the restriction's exact teardown; dropped lists names removed
 *   because the harness reported them unknown.
 * @throws rethrows any restriction error that is not the unknown-name case.
 */
export function restrictWithFallback(restrict, deny) {
  try {
    return { disposer: restrict({ deny }), dropped: [] }
  } catch (error) {
    const message = error?.message ?? String(error)
    const match = UNKNOWN_RE.exec(message)
    if (match === null) throw error
    const unknown = new Set(quotedNames(match[1]))
    if (unknown.size === 0) throw error
    const filtered = deny.filter(name => !unknown.has(name))
    if (filtered.length === deny.length) throw error
    const disposer = restrict({ deny: filtered })
    return { disposer, dropped: [...unknown] }
  }
}
