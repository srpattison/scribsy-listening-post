'use strict';
const { selectSample } = require('./quality-benchmark');

// Balanced diagnostic coverage, not population-weighted prevalence. Keep the
// model cap unchanged and remove private sampler fields before publication.
function selectFeatures(entries, limit = 400) {
  if (!entries.length) return { selected: [], coverage: { selected: 0, population: 0, strata: [] } };
  const { selected, manifest } = selectSample(entries, limit, 'LP-FEATURE-COVERAGE-1');
  return { selected: selected.map(entry => entry.value), coverage: manifest };
}
module.exports = { selectFeatures };
