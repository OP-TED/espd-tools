import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CACHE_FILE = `${__dirname}/.cache/codelist-labels.json`

const SPARQL_ENDPOINT = 'https://publications.europa.eu/webapi/rdf/sparql'

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

    for (const [code, entry] of Object.entries(data)) {
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
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 30000)

      const response = await fetch(SPARQL_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/sparql-query',
          Accept: 'application/sparql-results+json'
        },
        body: query,
        signal: controller.signal
      })

      clearTimeout(timeout)

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      const data = await response.json()
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
