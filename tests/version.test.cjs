const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'))

test('the version is MAJOR.MINOR.PATCH', () => {
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/)
})

test('the changelog\'s newest entry is the manifest\'s version', () => {
  const log = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')
  const first = log.match(/^## (\d+\.\d+\.\d+)/m)
  assert.ok(first, 'CHANGELOG.md has no "## X.Y.Z" entry')
  assert.equal(first[1], manifest.version)
})
