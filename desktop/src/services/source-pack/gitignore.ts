// Finder's PathSpec 0.12.1 gitwildmatch semantics. Adapted from python-pathspec,
// copyright 2013–2023 Caleb P. Burns, under the Mozilla Public License 2.0 (LICENSE).
function segmentPattern(segment: string): string {
  let regex = '';
  const literal = (c: string) => /[.*+?^${}()|[\]\\]/.test(c) ? '\\' + c : c;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (c === '\\') {
      if (++i === segment.length) throw new Error('无效的 .gitignore 规则：' + segment);
      regex += literal(segment[i]);
    } else if (c === '*') regex += '[^/]*';
    else if (c === '?') regex += '[^/]';
    else if (c === '[') {
      let start = i + 1;
      const negate = segment[start] === '^' || segment[start] === '!';
      if (negate) start++;
      const end = segment.indexOf(']', start + (segment[start] === ']' ? 1 : 0));
      if (end < 0) { regex += '\\['; continue; }
      const chars = segment.slice(start, end).replace(/[\\\]]/g, '\\$&');
      regex += '[' + (negate ? '^' : '') + chars + ']';
      i = end;
    } else regex += literal(c);
  }
  return regex;
}

function wildmatch(pattern: string): RegExp {
  const parts = pattern.split('/').filter((s, i, all) => s !== '**' || all[i - 1] !== '**');
  if (parts.length === 2 && parts[0] === '**' && parts[1] === '') return /^.+\/.*$/;
  if (parts[0] === '') parts.shift();
  else if ((parts.length === 1 || (parts.length === 2 && !parts[1])) && parts[0] !== '**') parts.unshift('**');
  if (parts.length > 1 && parts[parts.length - 1] === '') parts[parts.length - 1] = '**';
  const segments = parts.map((part, i) => {
    if (part === '**') {
      if (parts.length === 1) return '[^/]+(?:/.*)?';
      if (i === 0) return '(?:.+/)?';
      return i === parts.length - 1 ? '/.*' : '(?:/.+)?';
    }
    const slash = i === 0 || (i === 1 && parts[0] === '**') ? '' : '/';
    return slash + (part === '*' ? '[^/]+' : segmentPattern(part)) + (i === parts.length - 1 ? '(?:/.*)?' : '');
  });
  return new RegExp('^' + segments.join('') + '$', 'u');
}

export function rootIgnoreMatcher(contents: string): (relative: string) => boolean {
  const rules: {pattern: RegExp; ignored: boolean}[] = [];
  // Match Python str.splitlines(), including its legacy record separators.
  // eslint-disable-next-line no-control-regex
  for (const line of contents.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/u)) {
    const text = line.endsWith('\\ ') ? line.trimStart() : line.trim();
    if (!text || text === '/' || text.startsWith('#')) continue;
    const ignored = !text.startsWith('!');
    rules.push({ pattern: wildmatch(ignored ? text : text.slice(1)), ignored });
  }
  rules.reverse();
  return relative => rules.find(rule => rule.pattern.test(relative))?.ignored ?? false;
}
