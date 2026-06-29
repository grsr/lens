'use strict';

// Tokenise Loupe text into a flat token list, then parse into AST nodes.
// Returns an array of top-level forms.

function tokenise(text) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === ';') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '(') { tokens.push({ kind: 'lparen' }); i++; continue; }
    if (ch === ')') { tokens.push({ kind: 'rparen' }); i++; continue; }
    if (ch === "'") { tokens.push({ kind: 'quote' }); i++; continue; }
    // atom: any run of non-whitespace, non-paren, non-quote chars
    let j = i;
    while (j < text.length && !/[\s()'";]/.test(text[j])) j++;
    tokens.push({ kind: 'atom', text: text.slice(i, j) });
    i = j;
  }
  return tokens;
}

function classifyAtom(s) {
  if (/^-?\d+$/.test(s)) return { t: 'num', v: Number(s) };
  if (/^-?\d+\.\d+$/.test(s)) return { t: 'num', v: Number(s) };
  if (s.startsWith(':')) return { t: 'kw', s: s.slice(1) };
  return { t: 'sym', s };
}

function parse(tokens) {
  let pos = 0;

  function peek() { return tokens[pos]; }
  function consume() { return tokens[pos++]; }

  function parseForm() {
    const tok = peek();
    if (!tok) throw new Error('Unexpected end of input');

    if (tok.kind === 'quote') {
      consume(); // consume '
      const next = peek();
      if (!next || next.kind !== 'lparen') throw new Error("' must be followed by (");
      consume(); // consume (
      const items = [];
      while (peek() && peek().kind !== 'rparen') {
        const t = consume();
        if (t.kind !== 'atom') throw new Error(`Expected atom inside quoted list, got ${t.kind}`);
        items.push(classifyAtom(t.text));
      }
      if (!peek()) throw new Error('Unclosed quoted list');
      consume(); // consume )
      return { t: 'quote', items };
    }

    if (tok.kind === 'lparen') {
      consume(); // consume (
      const items = [];
      while (peek() && peek().kind !== 'rparen') {
        items.push(parseForm());
      }
      if (!peek()) throw new Error('Unclosed list');
      consume(); // consume )
      // (quote (...)) is equivalent to the '(...) reader shorthand.
      if (items.length === 2 && items[0].t === 'sym' && items[0].s === 'quote' &&
          items[1].t === 'list') {
        return { t: 'quote', items: items[1].items };
      }
      return { t: 'list', items };
    }

    if (tok.kind === 'atom') {
      consume();
      return classifyAtom(tok.text);
    }

    throw new Error(`Unexpected token kind: ${tok.kind}`);
  }

  const forms = [];
  while (pos < tokens.length) {
    forms.push(parseForm());
  }
  return forms;
}

function read(text) {
  return parse(tokenise(text));
}

module.exports = { read };
