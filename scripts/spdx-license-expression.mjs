const operatorTokens = new Set(['AND', 'OR', 'WITH'])

function tokenize(value) {
  const compact = value.replace(/\s+/g, '')
  const tokens = value.match(/\(|\)|\b(?:AND|OR|WITH)\b|[A-Za-z0-9.+:-]+/g) ?? []
  return tokens.join('') === compact ? tokens : null
}

export function isSpdxExpression(value) {
  if (typeof value !== 'string' || value.trim() === '') return false
  const tokens = tokenize(value.trim())
  if (!tokens) return false
  let cursor = 0

  function atom() {
    const token = tokens[cursor]
    if (!token || token === '(' || token === ')' || operatorTokens.has(token)) return false
    cursor += 1
    return true
  }

  function primary() {
    if (tokens[cursor] === '(') {
      cursor += 1
      if (!orExpression() || tokens[cursor] !== ')') return false
      cursor += 1
      return true
    }
    if (!atom()) return false
    if (tokens[cursor] === 'WITH') {
      cursor += 1
      if (!atom()) return false
    }
    return true
  }

  function andExpression() {
    if (!primary()) return false
    while (tokens[cursor] === 'AND') {
      cursor += 1
      if (!primary()) return false
    }
    return true
  }

  function orExpression() {
    if (!andExpression()) return false
    while (tokens[cursor] === 'OR') {
      cursor += 1
      if (!andExpression()) return false
    }
    return true
  }

  return orExpression() && cursor === tokens.length
}

export function spdxIdentifiers(expression) {
  if (!isSpdxExpression(expression)) return []
  return [...new Set((tokenize(expression) ?? [])
    .filter((token) => token !== '(' && token !== ')' && !operatorTokens.has(token)))]
}

export function cyclonedxLicense(value, url) {
  if (typeof value !== 'string' || value.trim() === '') return null
  const name = value.trim()
  const normalized = `${name} ${url ?? ''}`.toLowerCase()
  if (isSpdxExpression(name) && !/^(?:unknown|unlicensed|none)$/i.test(name)) return { expression: name }
  if (normalized.includes('apache') && normalized.includes('2.0')) return { expression: 'Apache-2.0' }
  if (/^(mit|mit license)$/i.test(name)) return { expression: 'MIT' }
  if (normalized.includes('eclipse public license') && normalized.includes('2.0')) return { expression: 'EPL-2.0' }
  if (normalized.includes('eclipse public license') && normalized.includes('1.0')) return { expression: 'EPL-1.0' }
  return { license: { name, ...(url ? { url } : {}) } }
}
