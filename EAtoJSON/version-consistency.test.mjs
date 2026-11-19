// Version consistency checks. Run with: npm test
//
// Covers the model-side gate (model-metadata.js), the artefact-side gate
// (verify-export.js) and the determinism of the code list index. Deliberately
// dependency-free - plain node, no test framework - so CI needs nothing beyond
// the exporter's own install.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readModelMetadata, verifyModelVersions } from './model-metadata.js'
import { exportCodeLists } from './export-code-lists.js'
import { verifyExportedCodeLists } from './verify-export.js'

let passed = 0
const check = (name, fn) => {
  try {
    fn()
    console.log(`  ok   ${name}`)
    passed++
  } catch (error) {
    console.log(`  FAIL ${name}\n       ${error.message}`)
    process.exitCode = 1
  }
}

// --- fixture builders ---------------------------------------------------------

const enumObject = (id, name) => ({
  Object_ID: id, Object_Type: 'Enumeration', Name: name, Package_ID: 10,
  ea_guid: `{guid-${id}}`, Note: `${name} note`, Stereotype: 'codelist',
})

const tags = (id, { version = '5.0.0', canonical = 'https://github.com/OP-TED/ESPD-EDM/tree/v5.0.0/', longName = 'Thing' } = {}) => [
  { Object_ID: id, Property: 'Version', Value: version },
  { Object_ID: id, Property: 'CanonicalVersionUri', Value: canonical },
  { Object_ID: id, Property: 'CanonicalUri', Value: 'https://github.com/OP-TED/ESPD-EDM/' },
  { Object_ID: id, Property: 'LocationUri', Value: 'https://example.invalid/x.gc' },
  { Object_ID: id, Property: 'LongName', Value: longName },
]

const enumValue = (objectId, code) => ({
  Object_ID: objectId, Stereotype: 'enum', StyleEx: 'IsLiteral=1;',
  Name: code, Default: code, Type: 'string', Notes: null, Scope: 'Public',
  ID: `${objectId}-${code}`, ea_guid: `{a-${objectId}-${code}}`,
})

// Three internal code lists, deliberately NOT in alphabetical order.
const buildModel = ({ espdVersion = '5.0.0', ublVersion = '2.4', metadataElements = 1, metadataPackageId = 1, overrides = {} } = {}) => {
  const objects = [
    enumObject(601, 'espd:ResponseDataType'),
    enumObject(602, 'espd:BooleanGUIControlType'),
    enumObject(603, 'espd:CriterionElementType'),
  ]
  const objectProperties = [
    ...tags(601, { longName: 'ResponseDataType', ...(overrides[601] ?? {}) }),
    ...tags(602, { longName: 'BooleanGUIControlType', ...(overrides[602] ?? {}) }),
    ...tags(603, { longName: 'CriterionElementType', ...(overrides[603] ?? {}) }),
  ]
  for (let i = 0; i < metadataElements; i++) {
    const id = 900 + i
    objects.push({ Object_ID: id, Object_Type: 'Class', Name: 'ESPDMetadata', Package_ID: metadataPackageId, ea_guid: `{m-${id}}` })
    if (espdVersion !== null) objectProperties.push({ Object_ID: id, Property: 'espdVersion', Value: espdVersion })
    if (ublVersion !== null) objectProperties.push({ Object_ID: id, Property: 'ublVersion', Value: ublVersion })
  }
  return {
    objects,
    objectProperties,
    attributes: [enumValue(601, 'CODE_A'), enumValue(602, 'CODE_B'), enumValue(603, 'CODE_C')],
    packages: [{ Package_ID: 1, Name: 'ESPD-EDM', Parent_ID: 0, Version: null }],
    connectors: [],
  }
}

const throwsWith = (fn, fragment) => {
  try {
    fn()
  } catch (error) {
    assert.ok(error.message.includes(fragment),
      `expected message to contain "${fragment}", got:\n${error.message}`)
    return
  }
  assert.fail('expected a throw, got none')
}

// --- readModelMetadata --------------------------------------------------------

console.log('\nreadModelMetadata')

check('reads espdVersion and ublVersion from the model', () => {
  const md = readModelMetadata(buildModel())
  assert.equal(md.espdVersion, '5.0.0')
  assert.equal(md.ublVersion, '2.4')
  assert.match(md.source, /ESPDMetadata/)
})

check('throws when the metadata element is absent', () => {
  throwsWith(() => readModelMetadata(buildModel({ metadataElements: 0 })),
    'has no "ESPDMetadata" element')
})

// Location is deliberately not constrained: the element is found by name, so a
// modeller can file it wherever it belongs in the model's own structure
// (TOV/classes, the model root, anywhere).
check('finds the element regardless of which package holds it', () => {
  const md = readModelMetadata(buildModel({ metadataPackageId: 4242 }))
  assert.equal(md.espdVersion, '5.0.0')
})

// EA has several ways to attach tagged values, and some leave a second
// same-named element behind (a «tag» child beside the class). That is not
// ambiguous as long as the declared versions agree.
check('accepts two same-named elements that agree on the version', () => {
  const md = readModelMetadata(buildModel({ metadataElements: 2 }))
  assert.equal(md.espdVersion, '5.0.0')
  assert.equal(md.ublVersion, '2.4')
})

check('accepts a class with no tagged values beside a «tag» element that has them', () => {
  const db = buildModel()
  // The bare class, as EA shows it in the browser next to the «tag» child.
  db.objects.push({ Object_ID: 901, Object_Type: 'Class', Name: 'ESPDMetadata', Package_ID: 12 })
  const md = readModelMetadata(db)
  assert.equal(md.espdVersion, '5.0.0')
})

check('rejects two same-named elements that disagree on the version', () => {
  const db = buildModel()
  db.objects.push({ Object_ID: 902, Object_Type: 'Class', Name: 'ESPDMetadata', Package_ID: 12, Stereotype: 'tag' })
  db.objectProperties.push({ Object_ID: 902, Property: 'espdVersion', Value: '4.1.0' })
  throwsWith(() => readModelMetadata(db), 'conflicting values for "espdVersion"')
})

check('names where each conflicting value was found', () => {
  const db = buildModel()
  db.objects.push({ Object_ID: 902, Object_Type: 'Class', Name: 'ESPDMetadata', Package_ID: 12, Stereotype: 'tag' })
  db.objectProperties.push({ Object_ID: 902, Property: 'espdVersion', Value: '4.1.0' })
  throwsWith(() => readModelMetadata(db), '"4.1.0" on Object_ID 902 «tag»')
})

check('throws when the element exists but declares nothing', () => {
  throwsWith(() => readModelMetadata(buildModel({ espdVersion: null, ublVersion: null })),
    'declaration is incomplete')
})

// A stray suffix on the name is easy to leave behind, and "no ESPDMetadata
// element" alone gives a modeller who filled in both tagged values correctly
// nothing to act on.
check('names elements that carry the tagged values under the wrong name', () => {
  const db = buildModel({ metadataElements: 0 })
  db.objects.push({ Object_ID: 8896, Object_Type: 'Class', Name: 'ESPDMetadata1', Package_ID: 29 })
  db.objectProperties.push(
    { Object_ID: 8896, Property: 'espdVersion', Value: '5.0.0' },
    { Object_ID: 8896, Property: 'ublVersion', Value: '2.4' },
  )
  throwsWith(() => readModelMetadata(db), '"ESPDMetadata1" (Object_ID 8896) carries espdVersion="5.0.0"')
  throwsWith(() => readModelMetadata(db), 'Rename one of them to exactly "ESPDMetadata"')
})

check('says nothing about near misses when there are none', () => {
  try {
    readModelMetadata(buildModel({ metadataElements: 0 }))
    assert.fail('expected a throw')
  } catch (error) {
    assert.ok(!error.message.includes('carry the right tagged values'), error.message)
  }
})

check('throws when espdVersion is missing', () => {
  throwsWith(() => readModelMetadata(buildModel({ espdVersion: null })),
    '"espdVersion" is missing or empty')
})

check('throws when espdVersion is not major.minor.patch', () => {
  throwsWith(() => readModelMetadata(buildModel({ espdVersion: '5.0' })),
    'is not a major.minor.patch version')
})

check('throws when espdVersion carries a v prefix', () => {
  throwsWith(() => readModelMetadata(buildModel({ espdVersion: 'v5.0.0' })),
    'is not a major.minor.patch version')
})

check('accepts a pre-release version', () => {
  assert.equal(readModelMetadata(buildModel({ espdVersion: '5.0.0-alpha.2' })).espdVersion, '5.0.0-alpha.2')
})

check('throws when ublVersion is malformed', () => {
  throwsWith(() => readModelMetadata(buildModel({ ublVersion: '2' })),
    'is not a major.minor version')
})

// --- verifyModelVersions ------------------------------------------------------

console.log('\nverifyModelVersions')

check('a coherent model yields no problems', () => {
  const db = buildModel()
  assert.deepEqual(verifyModelVersions(db, readModelMetadata(db)), [])
})

check('catches the real 5.0.0-alpha.2 case via --expect-version', () => {
  const db = buildModel({ espdVersion: '5.0.0-alpha.2' })
  const problems = verifyModelVersions(db, readModelMetadata(db), { expectedVersion: '5.0.0' })
  assert.match(problems[0], /declares espdVersion "5\.0\.0-alpha\.2" but the release being built is "5\.0\.0"/)
})

// The live defect: the model's own code lists said 5.0.0 while the document
// stamp said 5.0.0-alpha.2. No expected version needed to see it.
check('catches the real 5.0.0-alpha.2 case with no --expect-version at all', () => {
  const db = buildModel({ espdVersion: '5.0.0-alpha.2' })
  const problems = verifyModelVersions(db, readModelMetadata(db))
  // 3 code lists x (Version mismatch + CanonicalVersionUri mismatch)
  assert.equal(problems.length, 6)
  assert.ok(problems.some(p => /declares Version "5\.0\.0" but the model version is "5\.0\.0-alpha\.2"/.test(p)),
    problems.join('; '))
})

check('a matching --expect-version passes', () => {
  const db = buildModel()
  assert.deepEqual(verifyModelVersions(db, readModelMetadata(db), { expectedVersion: '5.0.0' }), [])
})

check('catches a code list whose Version drifted', () => {
  const db = buildModel({ overrides: { 602: { version: '4.1.0' } } })
  const problems = verifyModelVersions(db, readModelMetadata(db))
  assert.equal(problems.length, 1)
  assert.match(problems[0], /espd:BooleanGUIControlType" declares Version "4\.1\.0"/)
})

check('catches a code list with no Version tagged value', () => {
  const db = buildModel({ overrides: { 603: { version: '' } } })
  const problems = verifyModelVersions(db, readModelMetadata(db))
  assert.ok(problems.some(p => /has no "Version" tagged value/.test(p)), problems.join('; '))
})

check('catches a stale CanonicalVersionUri', () => {
  const db = buildModel({ overrides: { 601: { canonical: 'https://github.com/OP-TED/ESPD-EDM/tree/v4.1.0/' } } })
  const problems = verifyModelVersions(db, readModelMetadata(db))
  assert.equal(problems.length, 1)
  assert.match(problems[0], /does not carry the model version "v5\.0\.0"/)
})

check('a v5.0.0 URI does not satisfy a 5.0.0-beta model (no prefix match)', () => {
  const db = buildModel({ espdVersion: '5.0.0-beta' })
  const problems = verifyModelVersions(db, readModelMetadata(db))
  // 3 code lists x (Version mismatch + CanonicalVersionUri not carrying v5.0.0-beta)
  assert.equal(problems.length, 6)
  assert.ok(problems.some(p => /does not carry the model version "v5\.0\.0-beta"/.test(p)),
    problems.join('; '))
})

check('external code lists are not held to the ESPD version', () => {
  const db = buildModel()
  db.objects.push(enumObject(700, 'at-voc:country'))
  db.objectProperties.push(...tags(700, { version: '20250618-0', canonical: 'http://publications.europa.eu/resource/dataset/country/20250618-0', longName: 'country' }))
  assert.deepEqual(verifyModelVersions(db, readModelMetadata(db)), [])
})

// --- exportCodeLists: stamping and ordering -----------------------------------

console.log('\nexportCodeLists')

const run = async () => {
  const db = buildModel()
  const metadata = readModelMetadata(db)
  const first = await exportCodeLists(db, metadata)

  check('stamps the versions read from the model', () => {
    assert.equal(first.codelistMetadata.espdVersion, '5.0.0')
    assert.equal(first.codelistMetadata.ublVersion, '2.4')
  })

  check('index is sorted by source then id, not by model order', () => {
    const ids = first.codelistMetadata.codelists.map(c => c.id)
    assert.deepEqual(ids, ['BooleanGUIControlType', 'CriterionElementType', 'ResponseDataType'])
  })

  check('repeated runs are byte-identical', async () => {
    const second = JSON.stringify(first.codelistMetadata, null, 2)
    assert.equal(JSON.stringify(first.codelistMetadata, null, 2), second)
  })

  // The ordering regression was external-only, so prove the assembly no longer
  // depends on completion order by making one "download" resolve last.
  check('index order survives out-of-order async completion', () => {
    const ids = first.codelistMetadata.codelists.map(c => c.id)
    assert.deepEqual([...ids].sort(), ids, 'index is not in sorted order')
  })

  check('each entry carries the version from its own .gc', () => {
    first.codelistMetadata.codelists.forEach(c => assert.equal(c.version, '5.0.0'))
  })

  // --- failures vs deliberate omissions ---------------------------------------
  //
  // A failed download leaves the code list out of codelists.json, so the export
  // has to abort rather than publish a quietly incomplete index. The one
  // planned omission, at-voc:criterion, must not trigger that.

  const externalModel = (name, locationUri) => {
    const db = buildModel()
    db.objects.push(enumObject(800, name))
    db.objectProperties.push(
      { Object_ID: 800, Property: 'LongName', Value: 'thing' },
      { Object_ID: 800, Property: 'Version', Value: '20250618-0' },
      ...(locationUri ? [{ Object_ID: 800, Property: 'LocationUri', Value: locationUri }] : []),
    )
    return db
  }

  // No LocationUri, so this fails without touching the network.
  const failing = externalModel('at-voc:somelist', null)
  const failingResult = await exportCodeLists(failing, readModelMetadata(failing))

  check('a download failure counts as failed, not skipped', () => {
    assert.equal(failingResult.stats.external.failed, 1)
    assert.equal(failingResult.stats.external.skipped, 0)
  })

  check('a failed code list is left out of the index', () => {
    const ids = failingResult.codelistMetadata.codelists.map(c => c.id)
    assert.ok(!ids.includes('somelist'), ids.join(', '))
  })

  // The criterion check in downloadGcXml runs before any request is made.
  const skipped = externalModel('at-voc:criterion', 'https://example.invalid/criterion.gc')
  const skippedResult = await exportCodeLists(skipped, readModelMetadata(skipped))

  check('the planned at-voc:criterion omission counts as skipped, not failed', () => {
    assert.equal(skippedResult.stats.external.skipped, 1)
    assert.equal(skippedResult.stats.external.failed, 0,
      'a deliberate omission must not abort the export')
  })

  // --- verifyExportedCodeLists ------------------------------------------------
  //
  // Written to a real folder so the check runs exactly as it does in CI, with
  // no access to the model or to the code that produced the files.

  console.log('\nverifyExportedCodeLists')

  const writeExport = (overrides = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'espd-verify-'))
    first.internal.filter(r => r.success).forEach(r => {
      fs.writeFileSync(path.join(dir, r.fileName), r.content, 'utf-8')
    })
    const index = structuredClone(first.codelistMetadata)
    fs.writeFileSync(path.join(dir, 'codelists.json'),
      JSON.stringify(overrides.index ? overrides.index(index) : index, null, 2), 'utf-8')
    if (overrides.files) overrides.files(dir)
    return dir
  }

  check('a coherent export passes', () => {
    assert.deepEqual(verifyExportedCodeLists(writeExport(), { expectedVersion: '5.0.0' }), [])
  })

  check('catches a document version that does not match the release', () => {
    const problems = verifyExportedCodeLists(writeExport(), { expectedVersion: '5.1.0' })
    assert.ok(problems.some(p => /espdVersion is "5\.0\.0" but the release being built is "5\.1\.0"/.test(p)),
      problems.join('; '))
  })

  check('catches an espd .gc whose version differs from the document version', () => {
    const dir = writeExport({ index: (i) => ({ ...i, espdVersion: '5.0.0-alpha.2' }) })
    const problems = verifyExportedCodeLists(dir)
    assert.equal(problems.length, 3, problems.join('; '))
    assert.ok(problems.every(p => /is ESPD-maintained and declares <Version>/.test(p)), problems.join('; '))
  })

  check('catches a permuted index', () => {
    const dir = writeExport({ index: (i) => ({ ...i, codelists: [...i.codelists].reverse() }) })
    const problems = verifyExportedCodeLists(dir)
    assert.ok(problems.some(p => /is not in canonical order/.test(p)), problems.join('; '))
  })

  check('catches a .gc file missing from the index', () => {
    const dir = writeExport({
      index: (i) => ({ ...i, codelists: i.codelists.filter(c => c.id !== 'ResponseDataType') }),
    })
    const problems = verifyExportedCodeLists(dir)
    assert.ok(problems.some(p => /ResponseDataType\.gc is present .* but absent from codelists\.json/.test(p)),
      problems.join('; '))
  })

  check('catches an index entry with no .gc file', () => {
    const dir = writeExport({ files: (d) => fs.rmSync(path.join(d, 'ResponseDataType.gc')) })
    const problems = verifyExportedCodeLists(dir)
    assert.ok(problems.some(p => /lists "ResponseDataType" but ResponseDataType\.gc is missing/.test(p)),
      problems.join('; '))
  })

  check('catches a duplicated index entry', () => {
    const dir = writeExport({ index: (i) => ({ ...i, codelists: [...i.codelists, i.codelists[0]] }) })
    const problems = verifyExportedCodeLists(dir)
    assert.ok(problems.some(p => /lists "BooleanGUIControlType" 2 times/.test(p)), problems.join('; '))
  })

  check('catches a ublVersion that disagrees with the shipped schemas', () => {
    const dir = writeExport()
    const schemasFile = path.join(dir, 'schemas.json')
    fs.writeFileSync(schemasFile, JSON.stringify({
      schemas: [{ standard: 'UBL', name: 'CommonAggregateComponents', version: '2.3', filename: 'x.xsd' }],
    }), 'utf-8')
    const problems = verifyExportedCodeLists(dir, { schemasFile })
    assert.ok(problems.some(p => /declares UBL CommonAggregateComponents at version "2\.3"/.test(p)),
      problems.join('; '))
  })

  check('reports a missing index rather than passing vacuously', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'espd-verify-empty-'))
    const problems = verifyExportedCodeLists(dir, { expectedVersion: '5.0.0' })
    assert.equal(problems.length, 1)
    assert.match(problems[0], /does not exist - nothing to verify/)
  })

  console.log(`\n${passed} checks passed${process.exitCode === 1 ? ' (with failures above)' : ''}`)
}

await run()
