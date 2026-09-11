import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path, { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(dirname(fileURLToPath(import.meta.url)), '../prompts')
const resourcesRoot = path.resolve(dirname(fileURLToPath(import.meta.url)), '..')
const index = JSON.parse(fs.readFileSync(path.join(root, 'index.json'), 'utf8'))
const expectedCategories = new Set(['ships', 'characters', 'environment', 'effects', 'ui', 'audio'])
const statuses = new Set(['active', 'reference', 'inactive', 'processing'])
const purposes = new Set(['style', 'identity', 'alignment', 'pose'])
const opaque = new Set(['env-ocean-day', 'env-ocean-storm', 'env-ocean-moon', 'water-displacement'])
const errors = []
const sha = value => createHash('sha256').update(value).digest('hex')
const shaFile = file => sha(fs.readFileSync(file))

function confinedPath(base, relative, label) {
  if (typeof relative !== 'string' || !relative) {
    errors.push(`${label}: path must be a nonempty string`)
    return null
  }
  const resolved = path.resolve(base, relative)
  const contained = path.relative(base, resolved)
  if (!contained || contained.startsWith('..') || path.isAbsolute(contained)) {
    errors.push(`${label}: path escapes its root: ${relative}`)
    return null
  }
  if (!fs.existsSync(resolved)) return resolved
  const realBase = fs.realpathSync(base)
  const realPath = fs.realpathSync(resolved)
  const realContained = path.relative(realBase, realPath)
  if (fs.lstatSync(resolved).isSymbolicLink() || !realContained || realContained.startsWith('..') || path.isAbsolute(realContained)) {
    errors.push(`${label}: symbolic or escaping path is not allowed: ${relative}`)
    return null
  }
  return resolved
}

if (!Array.isArray(index.assets)) errors.push('index.assets must be an array')
if (index.count !== index.assets?.length) errors.push(`index.count ${index.count} != assets ${index.assets?.length}`)
if (index.imageCount !== index.assets?.filter(asset => asset.category !== 'audio').length) errors.push('index.imageCount does not match assets')
if (index.audioCount !== index.assets?.filter(asset => asset.category === 'audio').length) errors.push('index.audioCount does not match assets')
if (index.generatedBy !== '../tools/export_prompts.py') errors.push('index.generatedBy is stale')
const sourcePath = confinedPath(root, index.source, 'source')
const audioSourcePath = confinedPath(root, index.audioSource, 'audioSource')
if (sourcePath && shaFile(sourcePath) !== index.sourceSha256) errors.push('sourceSha256 does not match current art source')
if (audioSourcePath && shaFile(audioSourcePath) !== index.audioSourceSha256) errors.push('audioSourceSha256 does not match current audio source')

const ids = new Set()
const files = new Set()
const usedReferenceSets = new Set()
for (const asset of index.assets ?? []) {
  const label = asset.id ?? 'unknown-asset'
  if (typeof asset.id !== 'string' || ids.has(asset.id)) errors.push(`${label}: duplicate or invalid id`)
  ids.add(asset.id)
  if (!expectedCategories.has(asset.category)) errors.push(`${label}: invalid category ${asset.category}`)
  if (typeof asset.file !== 'string' || files.has(asset.file)) errors.push(`${label}: duplicate or invalid file ${asset.file}`)
  files.add(asset.file)
  if (typeof asset.file === 'string' && !asset.file.startsWith(`${asset.category}/`)) errors.push(`${label}: file is outside its category`)
  const file = confinedPath(root, asset.file, label)
  if (!file) continue
  const content = fs.readFileSync(file, 'utf8')
  if (sha(content) !== asset.sha256) errors.push(`${label}: sha256 mismatch`)
  const placeholders = [...new Set(content.match(/\[[A-Z][A-Z ]*\]/g) ?? [])].sort()
  if (JSON.stringify(placeholders) !== JSON.stringify(asset.placeholders)) errors.push(`${label}: placeholders do not match index`)
  if (!statuses.has(asset.status)) errors.push(`${label}: invalid status ${asset.status}`)
  if (!asset.allowedValues || JSON.stringify(asset.placeholders) !== JSON.stringify(Object.keys(asset.allowedValues))) errors.push(`${label}: allowedValues keys do not match placeholders`)
  for (const name of asset.placeholders) if (!asset.allowedValues?.[name]?.length) errors.push(`${label}: ${name} lacks allowed values`)

  for (const setName of asset.referenceSets ?? []) {
    usedReferenceSets.add(setName)
    const set = index.referenceSets?.[setName]
    if (!Array.isArray(set) || !set.length) {
      errors.push(`${label}: missing or empty reference set ${setName}`)
      continue
    }
    const paths = new Set()
    for (const item of set) {
      if (!item || typeof item.path !== 'string' || paths.has(item.path)) {
        errors.push(`${label}: invalid or duplicate reference path in ${setName}`)
        continue
      }
      paths.add(item.path)
      const referencePath = confinedPath(resourcesRoot, item.path, label)
      if (!referencePath || !fs.existsSync(referencePath) || !fs.statSync(referencePath).isFile()) errors.push(`${label}: missing reference ${item.path}`)
      if (!Array.isArray(item.purposes) || !item.purposes.length || item.purposes.some(purpose => !purposes.has(purpose))) errors.push(`${label}: invalid purposes for ${item.path}`)
      for (const [name, value] of Object.entries(item.appliesTo ?? {})) {
        if (!asset.placeholders.includes(name) || !asset.allowedValues?.[name]?.includes(value)) errors.push(`${label}: invalid appliesTo ${name}=${value}`)
      }
    }
  }

  if (asset.status === 'inactive' || asset.status === 'reference') {
    if (!/status: (INACTIVE|CURRENT MASTER ADOPTED)/i.test(content)) errors.push(`${label}: missing non-generative status`)
    if (/genuine alpha channel|Background pixels must be transparent|chroma magenta|Create ONE|produce ONE/i.test(content)) errors.push(`${label}: non-generative prompt contains executable generation or output suffix`)
  } else if (asset.category === 'audio') {
    if (/genuine alpha channel|Background pixels must be transparent|chroma magenta/i.test(content)) errors.push(`${label}: audio prompt contains image output suffix`)
  } else if (opaque.has(asset.id)) {
    if (/genuine alpha channel|Background pixels must be transparent|chroma magenta/i.test(content)) errors.push(`${label}: opaque prompt contains transparency suffix`)
  } else if (!/genuine alpha channel|Background pixels must be transparent|chroma magenta/i.test(content)) {
    errors.push(`${label}: transparent asset lacks alpha/chroma suffix`)
  }
  if (/(api[_-]?key|password|bearer\s+[a-z0-9._-]{12,}|sk-[a-z0-9]{16,})/i.test(content)) errors.push(`${label}: possible credential text`)
}

for (const [name, set] of Object.entries(index.referenceSets ?? {})) {
  if (!usedReferenceSets.has(name)) errors.push(`reference set is unused: ${name}`)
  if (!Array.isArray(set) || !set.length) errors.push(`reference set is invalid: ${name}`)
}
for (const name of usedReferenceSets) if (!(name in (index.referenceSets ?? {}))) errors.push(`unknown reference set: ${name}`)

const shared = index.shared ?? {}
if (!shared || Array.isArray(shared) || typeof shared !== 'object') errors.push('index.shared must be an object')
const sharedFiles = new Set()
for (const [key, row] of Object.entries(shared ?? {})) {
  const expected = `shared/${key}.txt`
  if (row?.file !== expected) errors.push(`shared prompt ${key}: unexpected file ${row?.file}`)
  const file = confinedPath(root, row?.file, `shared:${key}`)
  if (!file) continue
  sharedFiles.add(expected)
  if (shaFile(file) !== row?.sha256) errors.push(`shared prompt ${key}: sha256 mismatch`)
}
const sharedDir = path.join(root, 'shared')
for (const entry of fs.readdirSync(sharedDir, { withFileTypes: true })) {
  if (!entry.isFile()) errors.push(`shared prompt directory contains a nested directory: ${entry.name}`)
  const relative = `shared/${entry.name}`
  if (!sharedFiles.has(relative)) errors.push(`unindexed shared prompt: ${relative}`)
}
for (const category of expectedCategories) {
  const categoryDir = path.join(root, category)
  if (!fs.statSync(categoryDir, { throwIfNoEntry: false })?.isDirectory()) {
    errors.push(`missing prompt category: ${category}`)
    continue
  }
  for (const entry of fs.readdirSync(categoryDir, { withFileTypes: true })) {
    if (!entry.isFile()) errors.push(`prompt category contains nested directory: ${category}/${entry.name}`)
    if (!files.has(`${category}/${entry.name}`)) errors.push(`unindexed prompt: ${category}/${entry.name}`)
  }
}
for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
  if (entry.isDirectory() && !expectedCategories.has(entry.name) && entry.name !== 'shared') errors.push(`unexpected prompt directory: ${entry.name}`)
  if (entry.isFile() && ![index.source, index.audioSource, 'index.json', 'README.md'].includes(entry.name)) errors.push(`unexpected prompt file: ${entry.name}`)
}

console.log(JSON.stringify({ assets: index.assets?.length ?? 0, image: index.imageCount, audio: index.audioCount, shared: Object.keys(shared ?? {}).length, referenceSets: Object.keys(index.referenceSets ?? {}).length, errors }, null, 2))
if (errors.length) process.exitCode = 1
