import React from 'react';

/**
 * Minimal, safe markdown for AI output: `## headings`, `- bullets`, `**bold**`,
 * paragraphs. That's the whole grammar, on purpose — the office prompts are
 * written to emit only these four things, and pulling in a real markdown parser
 * would mean running a much larger renderer over text we didn't write. Anything
 * unrecognised falls through as a plain paragraph rather than being interpreted.
 *
 * DocQATool and SummarizerTool had byte-identical copies of this (down to the
 * regexes); the Red-Flag Scanner would have made three. Extracted so a fix lands
 * once. The only behaviour change on extraction: Summarizer's heading margin was
 * 14px and DocQA's was 12px — they're both 12px now.
 */

const styles = {
  h: { fontWeight: 700, fontSize: 14.5, margin: '12px 0 4px', color: '#0f172a' },
  p: { margin: '6px 0' },
  ul: { margin: '4px 0', paddingLeft: 20, lineHeight: 1.7 },
};

function inline(text, keyBase) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((p, i) =>
    /^\*\*[^*]+\*\*$/.test(p) ? <strong key={`${keyBase}-${i}`}>{p.slice(2, -2)}</strong> : p);
}

export function renderAiMarkdown(md) {
  const lines = String(md).split('\n');
  const out = [];
  let bullets = null;
  const flush = () => {
    if (bullets) { out.push(<ul key={`ul-${out.length}`} style={styles.ul}>{bullets}</ul>); bullets = null; }
  };
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (/^#{1,6}\s/.test(line)) { flush(); out.push(<div key={i} style={styles.h}>{line.replace(/^#{1,6}\s/, '')}</div>); }
    else if (/^[-*]\s+/.test(line)) { (bullets = bullets || []).push(<li key={i}>{inline(line.replace(/^[-*]\s+/, ''), i)}</li>); }
    else if (line === '') { flush(); }
    else { flush(); out.push(<p key={i} style={styles.p}>{inline(line, i)}</p>); }
  });
  flush();
  return out;
}
