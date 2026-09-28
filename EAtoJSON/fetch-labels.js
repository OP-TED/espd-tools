import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { dirname } from 'path'
import { fileURLToPath } from 'url'
import https from 'https'
import { HttpsProxyAgent } from 'https-proxy-agent'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CACHE_FILE = `${__dirname}/.cache/codelist-labels.json`

const SPARQL_ENDPOINT = 'https://publications.europa.eu/webapi/rdf/sparql'

/**
 * Decide whether `hostname` should bypass the proxy, per the NO_PROXY env var.
 * Supports comma-separated entries, a leading dot or `*.` wildcard, and `*`.
 */
function bypassesProxy (hostname) {
  const noProxy = process.env.NO_PROXY || process.env.no_proxy || ''
  if (!noProxy) return false
  return noProxy.split(',').map(s => s.trim().toLowerCase()).filter(Boolean).some(entry => {
    if (entry === '*') return true
    const host = hostname.toLowerCase()
    const bare = entry.replace(/^\*?\./, '') // "*.europa.eu" / ".europa.eu" -> "europa.eu"
    return host === bare || host.endsWith('.' + bare)
  })
}

/**
 * Ordered list of connection strategies (proxy agents) to try for `url`,
 * honouring HTTPS_PROXY/HTTP_PROXY and NO_PROXY. NO_PROXY only expresses a
 * PREFERENCE for a direct connection — in some corporate networks the host
 * resolves to a non-routable internal IP and is only reachable via the proxy,
 * so we return BOTH the preferred and the fallback path and let the caller
 * retry the alternate on a connection error.
 */
function connectionStrategies (url) {
  const { hostname } = new URL(url)
  const proxy =
    process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy
  const direct = { label: 'direct', agent: undefined }
  if (!proxy) return [direct]
  const viaProxy = { label: 'proxy', agent: new HttpsProxyAgent(proxy) }
  // Preferred first, alternate second: NO_PROXY match -> try direct then proxy;
  // otherwise -> try proxy then direct.
  return bypassesProxy(hostname) ? [direct, viaProxy] : [viaProxy, direct]
}

const CONNECTION_ERROR = /ETIMEDOUT|ECONNREFUSED|ENOTFOUND|ECONNRESET|EHOSTUNREACH|ENETUNREACH|socket hang up|timed out/i

/** Single HTTPS POST attempt with a specific agent. */
function httpsPostOnce (url, agent, { headers, body, timeout }) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'POST', headers, agent, timeout }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8')
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}`))
          return
        }
        try {
          resolve(JSON.parse(text))
        } catch (e) {
          reject(new Error(`Invalid JSON response: ${e.message}`))
        }
      })
    })
    req.on('timeout', () => req.destroy(new Error('Request timed out')))
    req.on('error', reject)
    req.end(body)
  })
}

/**
 * Proxy-aware HTTPS POST returning the parsed JSON body. Uses the `https`
 * module (which respects the chosen proxy agent) rather than global fetch,
 * which ignores HTTPS_PROXY/NO_PROXY. Tries the preferred connection strategy
 * and falls back to the alternate on a connection-level error.
 */
async function httpsPostJson (url, { headers = {}, body = '', timeout = 30000 } = {}) {
  const strategies = connectionStrategies(url)
  let lastError
  for (const { agent } of strategies) {
    try {
      return await httpsPostOnce(url, agent, { headers, body, timeout })
    } catch (error) {
      lastError = error
      // Only fall through to the alternate path on a connection-level failure;
      // an HTTP error (e.g. 500) is the server's answer and should not retry.
      if (!CONNECTION_ERROR.test(error.message)) throw error
    }
  }
  throw lastError
}

const QUERIES = {
  exclusionGround: `
    PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
    PREFIX skosxl: <http://www.w3.org/2008/05/skos-xl#>
    PREFIX purl: <http://purl.org/dc/elements/1.1/>

    SELECT ?concept ?code ?label ?definition
    FROM <http://publications.europa.eu/resource/authority/exclusion-ground>
    WHERE {
      ?concept a skos:Concept ;
               skosxl:prefLabel ?labelRes ;
               purl:identifier ?code .
      ?labelRes skosxl:literalForm ?label .
      FILTER (lang(?label) = "en")

      OPTIONAL {
        ?concept skos:definition ?definition .
        FILTER (lang(?definition) = "en")
      }
    }
    ORDER BY ?label
  `,
  selectionCriterion: `
    PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
    PREFIX skosxl: <http://www.w3.org/2008/05/skos-xl#>
    PREFIX purl: <http://purl.org/dc/elements/1.1/>

    SELECT ?concept ?code ?label ?definition
    FROM <http://publications.europa.eu/resource/authority/selection-criterion>
    WHERE {
      ?concept a skos:Concept ;
               skosxl:prefLabel ?labelRes ;
               purl:identifier ?code .
      ?labelRes skosxl:literalForm ?label .
      FILTER (lang(?label) = "en")

      OPTIONAL {
        ?concept skos:definition ?definition .
        FILTER (lang(?definition) = "en")
      }
    }
    ORDER BY ?label
  `
}

const codelistMap = new Map()

async function loadFromCache () {
  try {
    if (!existsSync(CACHE_FILE)) return false

    const json = await readFile(CACHE_FILE, 'utf-8')
    const data = JSON.parse(json)

    const entries = Object.entries(data)
    // Treat an empty (or non-object) cache as a MISS: an empty `{}` would
    // otherwise short-circuit the SPARQL fetch permanently, leaving every
    // criterion without its authoritative label/description. Only a populated
    // cache counts as a hit.
    if (entries.length === 0) return false

    for (const [code, entry] of entries) {
      codelistMap.set(code, entry)
    }

    return true
  } catch {
    return false
  }
}

async function saveToCache () {
  try {
    const cacheDir = dirname(CACHE_FILE)
    if (!existsSync(cacheDir)) {
      await mkdir(cacheDir, { recursive: true })
    }

    const data = Object.fromEntries(codelistMap)
    await writeFile(CACHE_FILE, JSON.stringify(data, null, 2), 'utf-8')
  } catch (error) {
    console.warn('Failed to save cache:', error.message)
  }
}

async function executeSparqlQuery (query, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // Node's global fetch (undici) ignores HTTPS_PROXY/NO_PROXY, so route via
      // the https module with a resolved proxy agent (see httpsPostJson).
      const data = await httpsPostJson(SPARQL_ENDPOINT, {
        headers: {
          'Content-Type': 'application/sparql-query',
          Accept: 'application/sparql-results+json'
        },
        body: query,
        timeout: 30000
      })
      return data.results.bindings
    } catch (error) {
      if (attempt === retries) {
        throw error
      }
      await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)))
    }
  }
}

async function fetchCodelists () {
  for (const [queryName, query] of Object.entries(QUERIES)) {
    try {
      const bindings = await executeSparqlQuery(query)

      for (const binding of bindings) {
        const code = binding.code?.value
        const label = binding.label?.value || ''
        const description = binding.definition?.value || ''

        if (code) {
          codelistMap.set(code, { label, description })
        }
      }
    } catch (error) {
      console.error(`Error loading ${queryName}:`, error.message)
    }
  }
}

async function loadCodelists () {
  const cacheLoaded = await loadFromCache()

  if (cacheLoaded) {
    return
  }

  await fetchCodelists()
  await saveToCache()
}

await loadCodelists()

function getLabels (code) {
  const result = codelistMap.get(code)
  return result || { label: '', description: '' }
}

export { getLabels }
