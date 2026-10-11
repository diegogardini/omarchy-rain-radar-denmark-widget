const { test } = require('node:test')
const assert = require('node:assert/strict')
const Words = require('../Words.js')

test('a saved language: English unless Danish', () => {
  assert.equal(Words.language('Dansk'), 'da')
  assert.equal(Words.language('da'), 'da')
  assert.equal(Words.language('English'), 'en')
  assert.equal(Words.language(undefined), 'en')
})

test('Danish has every English word', () => {
  assert.deepEqual(Object.keys(Words.TEXT.da).sort(), Object.keys(Words.TEXT.en).sort())
})

test('words that take values', () => {
  assert.equal(Words.t('dataAge', 'en', '14:20', '20 min'), 'Radar from 14:20 · 20 min ago')
  assert.equal(Words.t('dataAge', 'da', '14:20', '20 min'), 'Radar fra 14:20 · for 20 min siden')
  assert.equal(Words.t('outside', 'da', 'Malmö'), 'Din position (Malmö) er uden for Danmark. Vælg et sted i stedet.')
  assert.equal(Words.t('light', 'xx'), 'Light')
})

test('places the models name in English, in Danish', () => {
  assert.equal(Words.placeName('Copenhagen', 'da'), 'København')
  assert.equal(Words.placeName('near Copenhagen', 'da'), 'nær København')
  assert.equal(Words.placeName('near Odense', 'da'), 'nær Odense')
  assert.equal(Words.placeName('Pinned location', 'da'), 'Valgt sted')
  assert.equal(Words.placeName('Sweden', 'da'), 'Sverige')
  assert.equal(Words.placeName('Copenhagen', 'en'), 'Copenhagen')
})
