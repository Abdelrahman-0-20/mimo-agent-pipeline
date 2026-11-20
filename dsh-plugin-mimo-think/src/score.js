/**
 * Prompt-complexity scoring and tool classification for
 * dsh-plugin-mimo-think (mimo-agent-pipeline).
 *
 * Pure and dependency-free: scorePrompt() turns one incoming user message
 * into a weighted difficulty score plus the signal ids that fired, and
 * toolClass() splits completed tools into discovery (pure reads) versus work
 * (everything else) so the boost policy can re-assert effort only while the
 * session is actually working. messageText() extracts plain text from a
 * UserMessage-shaped value (content blocks, a bare string, or a text field).
 */

/** Exact tool names that are pure reads (kept aligned with the escalator's discovery set). */
const DISCOVERY_EXACT = new Set([
  'read',
  'grep',
  'glob',
  'working_directory',
  'mescal_status',
  'mthink_status',
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'read_mcp_resource',
  'mcp__memory__search_nodes',
  'mcp__memory__open_nodes',
  'mcp__memory__read_graph',
  'mcp__playwright__browser_snapshot',
  'mcp__playwright__browser_find',
  'mcp__playwright__browser_console_messages',
  'mcp__playwright__browser_network_request',
  'mcp__playwright__browser_network_requests',
  'mcp__playwright__browser_take_screenshot',
])

/** Tool-name prefixes that are pure reads (GitHub getters/listers/searchers, context7 docs). */
const DISCOVERY_PREFIXES = [
  'mcp__github__get_',
  'mcp__github__list_',
  'mcp__github__search_',
  'mcp__context7__',
]

/**
 * Classify one executed tool.
 * @param {string} name - the executed tool's name.
 * @returns {'discovery' | 'work'} unknown tools count as work.
 */
export function toolClass(name) {
  if (typeof name !== 'string') return 'work'
  if (DISCOVERY_EXACT.has(name)) return 'discovery'
  return DISCOVERY_PREFIXES.some(prefix => name.startsWith(prefix)) ? 'discovery' : 'work'
}

/**
 * Extract plain text from a UserMessage-shaped value.
 * Image and other non-text blocks are ignored.
 * @param {unknown} message - the inserted inbox message.
 * @returns {string} joined text blocks; '' when nothing text-like is present.
 */
export function messageText(message) {
  if (message === null || typeof message !== 'object') return ''
  const content = message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts = []
    for (const block of content) {
      if (block === null || typeof block !== 'object') continue
      if (typeof block.text === 'string' && (block.type === undefined || block.type === 'text')) {
        parts.push(block.text)
      }
    }
    return parts.join('\n')
  }
  if (typeof message.text === 'string') return message.text
  return ''
}

/**
 * Weighted difficulty signals, each contributing its weight at most once.
 * The constraint signal is counted separately with a cap so a prompt full of
 * "must" words cannot dominate the score.
 */
export const PATTERNS = Object.freeze([
  { id: 'design', weight: 2, re: /(?:\b(?:design|architect(?:ure)?|refactor|migrat(?:e|es|ed|ing|ion)|blueprint|redesign|schema|topolog\w*|infrastructur\w*|distributed|consensus|scalab\w*)\b)/i },
  { id: 'debug', weight: 2, re: /(?:\b(?:debug|root[ -]cause|stack[ -]?trace|race condition|deadlock|memory leak|flaky|bisect|reproduc\w*|segfault|core dump|regression)\b)/i },
  { id: 'analysis', weight: 2, re: /(?:\b(?:analy[sz]\w*|evaluat\w*|trade[ -]?offs?|optimi[sz]\w*|proof|proven|complexity|algorithm\w*|theorem|benchmark\w*|compare|comparison|pros and cons)\b)/i },
  { id: 'security', weight: 2, re: /(?:\b(?:secur\w*|vulnerab\w*|encrypt\w*|permission\w*|authenticat\w*|authoriz\w*|injection|xss|csrf|privilege\w*|sandbox|threat model)\b)/i },
  { id: 'why', weight: 1, re: /(?:\b(?:why|explain|reason(?:ing)? for|the cause)\b)/i },
  { id: 'failure', weight: 1, re: /(?:\b(?:error|exception|failing|failed|broken|crash\w*|does not work|doesn't work|bug)\b)/i },
  { id: 'file', weight: 1, re: /(?:\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|c|cc|cpp|h|hpp|sql|sh|bash|yml|yaml|json|toml|md|css|html)\b)/ },
  { id: 'code', weight: 2, re: /(?:\u0060{3})/ },
  { id: 'numbered', weight: 1, re: /(?:^\s*\d+\.\s)/m },
])

const CONSTRAINT_RE = /(?:\b(?:must|ensure|without|never|always|constraint\w*|requirements?|limitation\w*)\b)/gi
const QUESTION_RE = /\?/g
const BULLET_RE = /(?:^\s*[-*•]\s)/gm

/**
 * Score one prompt for difficulty.
 * @param {unknown} text - the message text.
 * @returns {{ score: number, hits: string[] }} weighted score and fired signal ids.
 */
export function scorePrompt(text) {
  if (typeof text !== 'string' || text.trim() === '') return { score: 0, hits: [] }
  const words = text.trim().split(/\s+/)
  let score = 0
  const hits = []

  const lengthId = words.length >= 150 ? 'length:long'
    : words.length >= 60 ? 'length:medium'
      : words.length >= 25 ? 'length:short' : null
  if (lengthId !== null) {
    score += lengthId === 'length:long' ? 3 : lengthId === 'length:medium' ? 2 : 1
    hits.push(lengthId)
  }

  for (const signal of PATTERNS) {
    if (signal.re.test(text)) {
      score += signal.weight
      hits.push(signal.id)
    }
  }

  const constraints = (text.match(CONSTRAINT_RE) ?? []).length
  if (constraints > 0) {
    const contribution = Math.min(constraints, 2)
    score += contribution
    hits.push('constraint x' + contribution)
  }

  if ((text.match(QUESTION_RE) ?? []).length >= 2) {
    score += 1
    hits.push('multi-question')
  }
  if ((text.match(BULLET_RE) ?? []).length >= 3) {
    score += 1
    hits.push('multi-step')
  }
  return { score, hits }
}
