'use strict';

const { createHash } = require('node:crypto');

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => [k, canonical(value[k])])
  );
  return value;
}

// Bind a review to the complete stored artifact, not merely its generation date.
// This is an integrity check, not an authentication mechanism. Only the attended
// publication step writes editorialReview; model generation never does.
function contentHash(brief) {
  const { editorialReview, ...content } = brief || {};
  return createHash('sha256').update(JSON.stringify(canonical(content))).digest('hex');
}

function isReviewed(brief) {
  const review = brief?.editorialReview;
  return !!(review?.version === 1 && review.status === 'approved' &&
    typeof review.reviewer === 'string' && review.reviewer.trim() &&
    Number.isFinite(Date.parse(review.reviewedAt)) &&
    Array.isArray(brief.answers) && brief.answers.length &&
    review.contentHash === contentHash(brief));
}

module.exports = { contentHash, isReviewed };
