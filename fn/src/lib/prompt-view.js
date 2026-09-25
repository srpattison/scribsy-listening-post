'use strict';

// The analysis prompt's view of a post and its comments — the SAME truncated
// strings the model is shown (CB-LISTEN-FIX-1b R3). aoai.analyzePost builds its
// prompt from this, and grounding-validator builds its units from it, so a
// quote from text past a cut can never validate.
//
// Engagement counts are deliberately NOT here. They are an Arctic Shift
// capture-time snapshot with variable per-row lag, so showing them to the
// model invites it to reason from what is mostly archiver timing (§3c).

const POST_BODY_CHARS = 6000;
const COMMENT_BLOCK_CHARS = 8000;
const NO_BODY = '(link/image post — no body)';

function promptView(post, comments) {
  const labelled = (comments || []).map((c, i) => `[comment ${i + 1}] ${c.body}`);
  const commentBlock = labelled.join('\n').slice(0, COMMENT_BLOCK_CHARS);
  // Each comment's visible body is whatever of it survives the block cut.
  const visibleComments = [];
  let offset = 0;
  labelled.forEach((line, i) => {
    const bodyStart = offset + `[comment ${i + 1}] `.length;
    visibleComments.push(String(comments[i].body).slice(0, Math.max(0, COMMENT_BLOCK_CHARS - bodyStart)));
    offset += line.length + 1;
  });
  const selftext = String((post && post.selftext) || '');
  return {
    title: (post && post.title) || '',
    body: (selftext || NO_BODY).slice(0, POST_BODY_CHARS),
    visibleSelftext: selftext.slice(0, POST_BODY_CHARS),
    commentBlock,
    visibleComments
  };
}

module.exports = { promptView, POST_BODY_CHARS, COMMENT_BLOCK_CHARS };
