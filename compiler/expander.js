'use strict';

const { read } = require('./reader.js');

function makeEnv(parent) {
  return { bindings: Object.create(null), parent };
}

function envLookup(env, name) {
  let e = env;
  while (e) {
    if (Object.prototype.hasOwnProperty.call(e.bindings, name)) {
      return { found: true, value: e.bindings[name] };
    }
    e = e.parent;
  }
  return { found: false };
}

function envBind(env, name, value) {
  env.bindings[name] = value;
}

// Bind a (def ...) form into env.
//   (def NAME EXPR)        scalar bind.
//   (def (a b c))          bind each name to its index 0,1,2,...
//   (def (a b c) SRC)      destructure SRC's cells, recycling (wrapping) to
//                          cover the names; a scalar SRC broadcasts to all.
function bindDef(form, env, ctx) {
  const target = form.items[1];
  if (target.t === 'sym') {
    envBind(env, target.s, expandNode(form.items[2], env, ctx));
    return;
  }
  if (target.t !== 'list') {
    throw new Error(`def: target must be a name or a name-list, got ${target.t}`);
  }
  const names = target.items.map(it => {
    if (it.t !== 'sym') throw new Error('def: a name-list holds only names');
    return it.s;
  });
  let cells;
  if (form.items.length >= 3) {
    cells = destructureCells(expandNode(form.items[2], env, ctx), env);
    if (cells.length === 0) throw new Error(`def: source for (${names.join(' ')}) has no cells`);
  } else {
    cells = names.map((_, i) => ({ t: 'num', v: i }));
  }
  for (let i = 0; i < names.length; i++) {
    envBind(env, names[i], cells[i % cells.length]);
  }
}

// Cells of a destructuring source: a collection yields its cells, a scalar
// yields itself (the caller's modulo wrap broadcasts it).
function destructureCells(src, env) {
  if (!src) return [];
  if (src.t === 'lens')   return src.items;
  if (src.t === 'oplens') return src.cells;
  if (src.t === 'tape')   return src.items;
  if (src.t === 'quote')  return src.items.map(it => {
    if (it.t === 'sym') { const r = envLookup(env, it.s); if (r.found) return r.value; }
    return it;
  });
  if (src.t === 'outputs') return src.ports.map(p => p.value);
  return [src];
}

// A fn body form is "real" (not meta) if it is a list starting with a sym
// that is not a kw, or is a num/sym that isn't preceded by a kw (i.e., a
// lone sym or num expression). Meta forms are kw/sym pairs or bare kws.
// Simplest heuristic: a fn is primitive if ALL body forms are kw atoms or
// syms that look like meta values, OR the body is empty.
// A non-primitive fn has at least one list or a lone sym/num that is
// the return expression.
function isPrimitiveFn(bodyForms) {
  if (bodyForms.length === 0) return true;
  // Walk through pairs: if a form is a kw, the next is its value (meta pair).
  // If a non-kw form appears outside a meta-pair position, it's a real body.
  let i = 0;
  while (i < bodyForms.length) {
    const f = bodyForms[i];
    if (f.t === 'kw') {
      // meta key; skip the value if present
      i++;
      if (i < bodyForms.length && bodyForms[i].t !== 'kw') i++; // skip value
      continue;
    }
    // Not a kw -- this is a real expression form.
    return false;
  }
  return true;
}

// Parse (fn (...) ...) param list into {inputs, outputs}.
function parseFnParams(listItems) {
  const inputs = [];
  const outputs = [];
  let inOutputs = false;
  for (const item of listItems) {
    if (item.t === 'sym' && item.s === '=>') { inOutputs = true; continue; }
    const name = item.t === 'kw' ? item.s : item.t === 'sym' ? item.s : null;
    if (name === null) continue;
    if (inOutputs) outputs.push(name);
    else inputs.push(name);
  }
  return { inputs, outputs };
}

// Split expanded arg list into positional and keyword args.
function splitArgs(argNodes) {
  const positional = [];
  const kwargs = Object.create(null);
  let i = 0;
  while (i < argNodes.length) {
    const a = argNodes[i];
    if (a && a.t === 'kw') {
      const key = a.s;
      if (i + 1 < argNodes.length && argNodes[i + 1].t !== 'kw') {
        const val = argNodes[i + 1];
        // Kwarg passthrough: an unset optional forwarded as `:key key` expands to
        // a bare self-named symbol (the param was never bound). Drop it so
        // "optional" carries through a fn body. A mistyped `:key other` keeps its
        // mismatched symbol and still surfaces, so this does not mask typos.
        if (!(val.t === 'sym' && val.s === key)) kwargs[key] = val;
        i += 2;
      } else {
        kwargs[key] = { t: 'flag' };
        i++;
      }
    } else {
      positional.push(a);
      i++;
    }
  }
  return { positional, kwargs };
}

// Resolve a score/notes item sym through env; _ and ~ stay as syms (rest/tie).
function expandScoreItem(node, env) {
  if (node.t === 'sym' && node.s !== '_' && node.s !== '~') {
    const r = envLookup(env, node.s);
    if (r.found) return r.value;
    throw new Error(`unknown name: ${node.s}`);
  }
  return node;
}

function expandQuoteItems(quoteNode, forNotes, env) {
  if (!forNotes) return quoteNode.items;
  return quoteNode.items.map(it => expandScoreItem(it, env));
}

// Instantiate one op-lens cell with :on and any extra kwargs bound.
// cell must be a fn node. extraKwargs maps kwarg name -> expanded node.
// Validates that fn's extra inputs (beyond inputs[0]) are covered by extraKwargs.
function expandOpLensCell(cell, onArg, cellIdx, ctx, extraKwargs) {
  if (!cell || cell.t !== 'fn') {
    throw new Error(`lens cell [${cellIdx}]: expected a fn, got ${cell && cell.t}`);
  }
  const inputs = cell.params && cell.params.inputs ? cell.params.inputs : [];
  if (inputs.length === 0) {
    throw new Error(`lens cell [${cellIdx}] fn must have at least one input; got 0`);
  }
  const extra = extraKwargs || {};
  // inputs[1..] must all be satisfied by extraKwargs.
  for (let k = 1; k < inputs.length; k++) {
    const name = inputs[k];
    if (!Object.prototype.hasOwnProperty.call(extra, name)) {
      throw new Error(
        `lens cell [${cellIdx}] fn requires kwarg :${name} which is not forwarded by thru`
      );
    }
  }
  // Check that every forwarded kwarg is declared by this fn (inputs[1..]).
  const extraInputNames = new Set(inputs.slice(1));
  for (const k of Object.keys(extra)) {
    if (!extraInputNames.has(k)) {
      throw new Error(
        `lens cell [${cellIdx}] fn does not declare forwarded kwarg :${k}`
      );
    }
  }
  const callFrame = makeEnv(cell.env);
  envBind(callFrame, inputs[0], onArg);
  for (const [k, v] of Object.entries(extra)) {
    envBind(callFrame, k, v);
  }
  return expandFnBodySingle(cell.body, callFrame, ctx);
}

// Classify expanded lens items.
// Returns {t:'lens', items, names} for all-data, {t:'oplens', cells, names} for op or mixed.
// Throws on empty lens only. Arity is checked at thru-expansion time when kwargs are known.
// names: original sym strings before resolution, used by tape subkind resolution.
function classifyLens(resolved, origNames) {
  if (resolved.length === 0) throw new Error('lens: must have at least one cell');
  const hasFn = resolved.some(item => item.t === 'fn');
  if (hasFn) {
    const node = { t: 'oplens', cells: resolved };
    if (origNames) node.names = origNames;
    return node;
  }
  const node = { t: 'lens', items: resolved };
  if (origNames) node.names = origNames;
  return node;
}

// Resolve the LIST argument of (thru LIST IDX) to a lens or oplens node.
// Accepts a quoted list (cells resolved through env / note names), an already
// resolved lens/oplens node, or a sym bound to one. Throws on a mixed fn/value
// list (apply-or-not is undecidable).
function resolveThruList(listNode, env, ctx) {
  let resolved = listNode;
  if (resolved && resolved.t === 'quote') {
    const cells = resolved.items.map(it => {
      if (it.t === 'sym') {
        const r = envLookup(env, it.s);
        if (r.found) return r.value;
      }
      return it;
    });
    resolved = classifyLens(cells, resolved.items.map(it => (it.t === 'sym' ? it.s : null)));
  }
  if (!resolved) throw new Error('thru: list argument is missing');
  // A tape is a dynamic data buffer; thru reads cells from it just like a data lens.
  if (resolved.t === 'tape') return resolved;
  if (resolved.t === 'lens' || resolved.t === 'oplens') {
    // Homogeneity: classifyLens already split all-fn (oplens) from any-non-fn (lens).
    // Catch the genuinely mixed case (some fns, some values) here.
    if (resolved.t === 'oplens') {
      const hasValue = resolved.cells.some(c => c.t !== 'fn');
      if (hasValue) {
        throw new Error('thru: list mixes fn and value cells; a list must be all-fns or all-values');
      }
    }
    return resolved;
  }
  throw new Error(`thru: list argument must be a list/lens, got ${resolved.t}`);
}

// Build the thru result node from a resolved list + index. Out-of-range index
// wraps (floored modulo) in the opthru/op_thru lowering.
// Op-lens: returns an 'oplens-sel' node remembering the cells + index. Applying
// it (call-head position, applyOplensSel) inlines the picked cell over the args;
// using it as a value lowers to its index. Data lens/tape: the IDX-th value.
function buildThru(listResolved, atArg) {
  if (listResolved.t === 'oplens') {
    return { t: 'oplens-sel', cells: listResolved.cells, at: atArg };
  }
  // A lens whose cells are tapes is a collection of buffers, not of values. The
  // pick is a tape, so it cannot decode to one value: remember the cells + index
  // as a buflens-sel and distribute the consuming op over the cells (the op runs
  // once per tape, op_thru picks the output) when this is used as a call arg.
  if (listResolved.t === 'lens' && isBufferLens(listResolved)) {
    return { t: 'buflens-sel', cells: listResolved.items, at: atArg };
  }
  return { t: 'call', op: 'thru', args: [listResolved, atArg], kwargs: {} };
}

// A lens whose cells are all tapes (dynamic buffers), distinct from a data lens
// whose cells are numbers (a scale, decoded to a value by op_thru).
function isBufferLens(lensNode) {
  return lensNode.items.length > 0
    && lensNode.items.every(it => it && it.t === 'tape');
}

// Distribute a primitive call over a buflens-sel argument: the call is rebuilt
// once per tape cell with that arg replaced, and op_thru picks the result value
// at the selection index. All cells run in lockstep; switching the index swaps
// which output is read (a stateless demux, the analog "all voices run" model).
function distributeBufLensSel(name, positional, kwargs, ctx) {
  const ai = positional.findIndex(a => a && a.t === 'buflens-sel');
  if (ai < 0) return null;
  const sel = positional[ai];
  const results = sel.cells.map(cell => {
    const args = positional.slice();
    args[ai] = cell;
    return { t: 'call', op: name, args, kwargs };
  });
  return { t: 'opthru', results, at: sel.at };
}

// Apply an 'oplens-sel' to call args: inline each cell over the first positional
// argument, forwarding extra kwargs to each fn cell. Returns an 'opthru' node.
function applyOplensSel(sel, positional, kwargs, ctx) {
  const onArg = positional[0];
  if (!onArg) throw new Error('thru: applied op-lens needs at least one argument');
  const results = sel.cells.map((cell, i) => expandOpLensCell(cell, onArg, i, ctx, kwargs || {}));
  return { t: 'opthru', results, at: sel.at };
}

// Main node expander.
function expandNode(node, env, ctx) {
  const { report } = ctx;

  if (node.t === 'num' || node.t === 'kw' || node.t === 'flag') return node;

  if (node.t === 'sym') {
    const r = envLookup(env, node.s);
    if (r.found) return r.value;
    // Unresolved sym: return as-is so kwarg passthrough (:key key) can drop it.
    // Any sym that reaches the lowerer without being dropped will error there.
    return node;
  }

  if (node.t === 'quote') return node; // bare quoted list

  if (node.t !== 'list') return node;

  const items = node.items;
  if (items.length === 0) return node;

  const head = items[0];
  if (head.t !== 'sym') {
    // Collections-are-functions: a head of (thru OPLENS IDX) -- or its sugar
    // (squint OPLENS SEL) -- applied to args means "the IDX-th op-lens cell
    // applied to the args". The head expands to an 'oplens-sel' which we apply
    // here via the opthru machinery (applyOplensSel builds the op_thru node).
    if (head.t === 'list') {
      const headExpanded = expandNode(head, env, ctx);
      if (headExpanded && headExpanded.t === 'oplens-sel') {
        const callArgs = items.slice(1).map(it => (it.t === 'kw' ? it : expandNode(it, env, ctx)));
        const { positional, kwargs } = splitArgs(callArgs);
        return applyOplensSel(headExpanded, positional, kwargs, ctx);
      }
      // Inline port-select: a multi-output call as the head, e.g. ((phasor ..) :tick)
      // or ((vcf ..) :hp), picks a port without binding the call first.
      if (headExpanded && headExpanded.t === 'outputs') {
        return expandPortSelect(headExpanded, items.slice(1), env, ctx);
      }
      // A thru/squint head applied to args but it picks values, not fns: error.
      const headSym = head.items[0] && head.items[0].t === 'sym' ? head.items[0].s : null;
      if (headSym === 'thru' || headSym === 'squint') {
        throw new Error(
          `${headSym}: only an op-lens (all-fn list) can be applied to arguments; this list holds values`
        );
      }
    }
    // Non-sym head -- expand as generic list
    return { t: 'call', op: '?', args: items.slice(1).map(it => expandNode(it, env, ctx)) };
  }

  const name = head.s;

  // Special forms.

  if (name === 'fn') {
    const paramList = items[1] && items[1].t === 'list' ? items[1].items : [];
    const { inputs, outputs } = parseFnParams(paramList);
    const bodyForms = items.slice(2);
    const primitive = isPrimitiveFn(bodyForms);
    return { t: 'fn', params: { inputs, outputs }, body: bodyForms, env, primitive };
  }

  if (name === 'lens') {
    if (items.length === 2 && items[1].t === 'quote') {
      return { t: 'lens', items: items[1].items };
    }
    const cellNodes = items.slice(1);
    // Capture original sym strings before resolution so tape subkind resolution
    // can match item names against cell indices at compile time.
    const origNames = cellNodes.map(it => (it.t === 'sym' ? it.s : null));
    const resolved = cellNodes.map(it => expandNode(it, env, ctx));
    return classifyLens(resolved, origNames);
  }

  if (name === 'tape') {
    let subkind = null;
    let quoteNode;
    if (items.length === 2 && items[1].t === 'quote') {
      quoteNode = items[1];
    } else if (items.length >= 3 && items[2] && items[2].t === 'quote') {
      const sub = items[1];
      subkind = sub.t === 'sym' ? sub.s : sub.t === 'kw' ? sub.s : null;
      quoteNode = items[2];
    } else {
      quoteNode = items[items.length - 1];
    }
    // Resolve a sym arg: (tape pat) where pat is bound to a quote node in the env.
    if (quoteNode && quoteNode.t === 'sym') {
      const r = envLookup(env, quoteNode.s);
      if (r.found && r.value && r.value.t === 'quote') quoteNode = r.value;
    }
    const forNotes = subkind === 'notes';
    const rawItems = quoteNode && quoteNode.t === 'quote'
      ? expandQuoteItems(quoteNode, forNotes, env)
      : [expandNode(quoteNode, env, ctx)];

    // Resolve sym cells (x, ., note names, etc.) through the env so lowerTape
    // receives only num nodes. Throw on any sym that does not resolve.
    const resolvedItems = rawItems.map(item => {
      if (item.t !== 'sym') return item;
      const r = envLookup(env, item.s);
      if (r.found) return r.value;
      throw new Error(`unknown name: ${item.s}`);
    });

    // Subkind name resolution: when subkind names a binding in scope that is a
    // lens or oplens, resolve each seed item sym to its index in that binding's
    // cells. Numeric literals pass through as direct indices.
    let tapeItems = resolvedItems;
    if (subkind && !forNotes) {
      const lookup = envLookup(env, subkind);
      if (lookup.found) {
        const binding = lookup.value;
        if (binding.t !== 'lens' && binding.t !== 'oplens') {
          throw new Error(
            `tape: subkind "${subkind}" must be a lens or op-lens; got "${binding.t}"`
          );
        }
        const cellNames = binding.names || null;
        if (!cellNames) {
          throw new Error(
            `tape: subkind "${subkind}" has no cell names; cannot resolve items`
          );
        }
        if (rawItems.length === 0) {
          throw new Error(
            `tape: subkind "${subkind}" seed must not be empty`
          );
        }
        tapeItems = rawItems.map(item => {
          if (item.t === 'num') return item; // numeric literal -> direct index
          const itemName = item.t === 'sym' ? item.s : null;
          if (itemName === null) {
            throw new Error(
              `tape: subkind "${subkind}" seed item must be a sym or number; got "${item.t}"`
            );
          }
          const idx = cellNames.indexOf(itemName);
          if (idx === -1) {
            throw new Error(
              `tape: item "${itemName}" not found in "${subkind}" (cells: ${cellNames.join(', ')})`
            );
          }
          return { t: 'num', v: idx };
        });
      }
      // If subkind does not resolve (not found in env), fall through and keep
      // raw items (the subkind may be an intrinsic tag handled elsewhere, or
      // the user misspelled a name -- unresolved syms are already tracked).
    }

    const result = { t: 'tape', items: tapeItems };
    if (subkind) result.subkind = subkind;
    return result;
  }

  if (name === 'audio') {
    const rawArgs = items.slice(1).map(it => expandNode(it, env, ctx));
    const { kwargs } = splitArgs(rawArgs);
    const result = { t: 'audio' };
    if (kwargs.seconds !== undefined) result.seconds = kwargs.seconds;
    if (kwargs.length !== undefined) result.length = kwargs.length;
    return result;
  }

  if (name === 'score') {
    // (score '(NOTE _ ~ NOTE ...)) produces a dual-port object:
    //   :notes  = the pitch sequence; _ and ~ hold the previous note (a v/oct
    //             sequencer is a sample-and-hold, so a rest must not drop the
    //             pitch to 0 = C-1 and pitch-bend the voice's release tail down).
    //   :rhythm = a tape of 0/4095 gates (4095 for actual notes, 0 for _ and ~).
    const q = items[1];
    const rawItems = q && q.t === 'quote' ? expandQuoteItems(q, true, env) : [];
    const rhythm = rawItems.map(it => {
      if (it.t === 'sym' && (it.s === '_' || it.s === '~')) return { t: 'num', v: 0 };
      return { t: 'num', v: 4095 };
    });
    // Carry the last sounded pitch through rests/ties; leading rests hold 0.
    let held = { t: 'num', v: 0 };
    const noteItems = rawItems.map(it => {
      if (it.t === 'sym' && (it.s === '_' || it.s === '~')) return held;
      held = it;
      return it;
    });
    return {
      t: 'outputs',
      ports: [
        { name: 'notes', value: { t: 'tape', subkind: 'notes', items: noteItems } },
        { name: 'rhythm', value: { t: 'tape', subkind: 'rhythm', items: rhythm } },
      ],
    };
  }

  // (normal JACK DEFAULT): the jack when a cable is patched, else the default.
  // Sugar over the `connected` predicate.
  if (name === 'normal') {
    const jack = expandNode(items[1], env, ctx);
    const def_ = expandNode(items[2], env, ctx);
    return { t: 'call', op: 'if',
             args: [{ t: 'connected', jack }, jack, def_],
             kwargs: Object.create(null) };
  }

  // (connected JACK): VMAX if a cable is patched into JACK, else 0.
  if (name === 'connected') {
    return { t: 'connected', jack: expandNode(items[1], env, ctx) };
  }

  if (name === 'morph') {
    return { t: 'morph', args: items.slice(1).map(it => expandNode(it, env, ctx)) };
  }

  if (name === 'feedback') {
    return { t: 'feedback', args: items.slice(1).map(it => expandNode(it, env, ctx)) };
  }

  if (name === 'z1') {
    return { t: 'z1', x: expandNode(items[1], env, ctx) };
  }

  if (name === 'notes') {
    const arg = items[1];
    if (arg && arg.t === 'sym') {
      const r = envLookup(env, arg.s);
      if (r.found) return r.value;
      throw new Error(`unknown name: ${arg.s}`);
    }
    return { t: 'num', v: 0 };
  }

  if (name === 'outputs') {
    const ports = items.slice(1).map(it => {
      if (it.t === 'list' && it.items.length >= 2) {
        const portName = it.items[0].s || '?';
        const value = expandNode(it.items[1], env, ctx);
        return { name: portName, value };
      }
      return { name: '?', value: expandNode(it, env, ctx) };
    });
    return { t: 'outputs', ports };
  }

  // (len LIST): a static lens/oplens/quote folds to its cell count at compile time
  // (squint needs this to spread the selector across the list length).
  if (name === 'len' && items.length === 2) {
    const arg = expandNode(items[1], env, ctx);
    if (arg && arg.t === 'lens')   return { t: 'num', v: arg.items.length };
    if (arg && arg.t === 'oplens') return { t: 'num', v: arg.cells.length };
    if (arg && arg.t === 'quote')  return { t: 'num', v: arg.items.length };
    if (arg && arg.t === 'num')    return { t: 'num', v: 1 }; // scalar = length-1
    // Dynamic tape: fall through to the op_len primitive path.
  }

  // (thru LIST IDX): positional. LIST first, index second. Out-of-range wraps.
  // A value cell IS the value; an op-lens cell is selected here and applied via
  // ((thru ops IDX) X) (handled in the non-sym-head path above).
  if (name === 'thru') {
    const listNode = expandNode(items[1], env, ctx);
    // A scalar is a length-1 collection: any index wraps to it.
    if (listNode && listNode.t === 'num') return listNode;
    const listResolved = resolveThruList(listNode, env, ctx);
    const atArg = items[2] !== undefined ? expandNode(items[2], env, ctx) : { t: 'num', v: 0 };
    return buildThru(listResolved, atArg);
  }

  // def / <- are handled by body processors but can appear as raw nodes in fn bodies.
  if (name === 'def' || name === '<-') return node;

  // --- function call or unknown op ---

  const headResolved = envLookup(env, name);

  if (headResolved.found) {
    const fnNode = headResolved.value;

    if (fnNode && fnNode.t === 'fn') {
      if (fnNode.primitive) {
        // Primitive op (defined in prelude but implemented in runtime): emit call node.
        const rawArgs = items.slice(1).map(it => expandNode(it, env, ctx));
        const { positional, kwargs } = splitArgs(rawArgs);
        // Ops that accept :trig default to master when :trig is absent.
        // SPEC: skip injection when an alternative rate kwarg (:hz, :bpm) is present.
        const CLK_OPS = new Set(['trig', 'step', 'seek', 'turns', 'every', 'random', 'chance', 'walk',
          'euclid', 'hits', 'gates', 'onsets', 'groove',
          'recordhead-per-cell', 'recordhead-gated',
          'recordhead-len-capped', 'recordhead-len-capped-gated']);
        if (CLK_OPS.has(name) && !kwargs.trig && !kwargs.hz && !kwargs.bpm) {
          const masterR = envLookup(env, 'master');
          if (masterR.found) kwargs.trig = masterR.value;
        }

        // groove: each drum voice's :on tape becomes a :trig (hits on-tape clk),
        // and groove is the mix of the voices.
        if (name === 'groove') {
          const clkNode = kwargs.trig;
          if (clkNode) {
            for (const voiceArg of positional) {
              if (voiceArg.t === 'call' && voiceArg.kwargs && voiceArg.kwargs.on) {
                const onVal = voiceArg.kwargs.on;
                if (onVal.t === 'tape' || onVal.t === 'quote') {
                  const hitsCall = { t: 'call', op: 'hits', args: [onVal], kwargs: { trig: clkNode } };
                  const rest = Object.create(null);
                  for (const [k, v] of Object.entries(voiceArg.kwargs)) {
                    if (k !== 'on') rest[k] = v;
                  }
                  voiceArg.kwargs = Object.assign(Object.create(null), { trig: hitsCall }, rest);
                }
              }
            }
          }
          return { t: 'call', op: 'mix', args: positional, kwargs: Object.create(null) };
        }

        // A tape argument selected at runtime from a lens of tapes: distribute
        // this op over each tape and pick the result value at the selection index.
        const distributed = distributeBufLensSel(name, positional, kwargs, ctx);
        if (distributed) return distributed;

        // Primitive fn with named outputs: return an outputs node so port selection works.
        // SPEC: each port gets its own call node with :port baked in; lowerer emits one slot each.
        const outputs = fnNode.params && fnNode.params.outputs;
        if (outputs && outputs.length > 0) {
          // An explicit :port (a name like :port hp, or a number) selects that one
          // output directly -- sugar for port-select ((op ..) :hp).
          if (kwargs.port) {
            const pi = kwargs.port.t === 'num' ? kwargs.port.v
                     : kwargs.port.t === 'sym' ? outputs.indexOf(kwargs.port.s) : -1;
            if (pi >= 0 && pi < outputs.length) {
              const pk = Object.assign({}, kwargs, { port: { t: 'num', v: pi } });
              return { t: 'call', op: name, args: positional, kwargs: pk };
            }
          }
          const ports = outputs.map((portName, i) => {
            const portKwargs = Object.assign({}, kwargs, { port: { t: 'num', v: i } });
            return { name: portName, value: { t: 'call', op: name, args: positional, kwargs: portKwargs } };
          });
          return { t: 'outputs', ports };
        }
        return { t: 'call', op: name, args: positional, kwargs,
                 sig: (fnNode.params && fnNode.params.inputs) || undefined };
      }
      return expandFnCall(name, fnNode, items.slice(1), env, ctx);
    }

    if (fnNode && fnNode.t === 'outputs') {
      return expandPortSelect(fnNode, items.slice(1), env, ctx);
    }

    // The resolved value is some other node (tape, lens, num, etc.) used as
    // a positional -- caller is doing something like (step rungle) where rungle
    // is a tape node. We resolve the name; the surrounding call handles the node.
    // This shouldn't reach here as call-head... but handle gracefully.
    return fnNode;
  }

  // Unknown op.
  const rawArgs = items.slice(1).map(it => expandNode(it, env, ctx));
  const { positional, kwargs } = splitArgs(rawArgs);
  report.unknownOps.add(name);
  return { t: 'call', op: name, args: positional, kwargs };
}

function expandPortSelect(outputsNode, argItems, env, ctx) {
  if (argItems.length === 1 && argItems[0].t === 'kw') {
    const portName = argItems[0].s;
    const port = outputsNode.ports.find(p => p.name === portName);
    if (port) return port.value;
  }
  return outputsNode;
}

// Expand a fn call by inlining the body.
function expandFnCall(opName, fnNode, argItems, callEnv, ctx) {
  const rawArgs = argItems.map(it => expandNode(it, callEnv, ctx));
  const { positional, kwargs } = splitArgs(rawArgs);
  const { inputs, outputs } = fnNode.params;

  // New frame extends fn.env (def-site) with params bound to call-site values.
  const callFrame = makeEnv(fnNode.env);

  for (let i = 0; i < inputs.length; i++) {
    if (i < positional.length) {
      envBind(callFrame, inputs[i], positional[i]);
    }
    // Unbound positionals fall through to fn.env / prelude at lookup time.
  }

  // Bind kwargs into the call frame so fn body can reference them.
  for (const [k, v] of Object.entries(kwargs)) {
    envBind(callFrame, k, v);
  }

  // Named outputs -> multi-output expansion.
  if (outputs.length > 0) {
    return expandFnBodyMulti(fnNode.body, callFrame, outputs, ctx);
  }

  return expandFnBodySingle(fnNode.body, callFrame, ctx);
}

// Expand a fn body with named output ports.
function expandFnBodyMulti(bodyForms, env, outputNames, ctx) {
  const localEnv = makeEnv(env);
  const ports = [];

  for (const form of bodyForms) {
    if (form.t === 'list' && form.items[0] && form.items[0].t === 'sym') {
      const h = form.items[0].s;
      if (h === 'def') {
        bindDef(form, localEnv, ctx);
        continue;
      }
      if (h === '<-') {
        // (<- PORTNAME VALUE ...) inside fn body
        const sinkSym = form.items[1];
        const cable = expandCableInBody(form, localEnv, ctx);
        if (sinkSym && sinkSym.t === 'sym' && outputNames.includes(sinkSym.s)) {
          ports.push({ name: sinkSym.s, value: cable.value });
        } else {
          // Genuine local cables (tape/buffer writes) get lowered; output-port
          // bindings do not (the value flows through the returned port).
          ctx.localCables.push(cable);
        }
        continue;
      }
    }
    // Meta kw pairs at the top of fn body -- skip.
    if (form.t === 'kw') continue;
    expandNode(form, localEnv, ctx);
  }

  return { t: 'outputs', ports };
}

// Expand a fn body and return the last expression.
function expandFnBodySingle(bodyForms, env, ctx) {
  const localEnv = makeEnv(env);
  let last = { t: 'num', v: 0 };

  for (const form of bodyForms) {
    if (form.t === 'kw') continue; // meta
    if (form.t === 'list' && form.items[0] && form.items[0].t === 'sym') {
      const h = form.items[0].s;
      if (h === 'def') {
        bindDef(form, localEnv, ctx);
        continue;
      }
      if (h === '<-') {
        const cable = expandCableInBody(form, localEnv, ctx);
        ctx.localCables.push(cable);
        continue;
      }
    }
    last = expandNode(form, localEnv, ctx);
  }

  return last;
}

// Expand a (<- SINK VALUE ...) form, returning {sink, value, kwargs}.
function expandCableInBody(form, env, ctx) {
  return expandCableForm(form, env, ctx);
}

function expandCableForm(form, env, ctx) {
  const items = form.items; // [<-, SINK, args...]
  const sinkNode = items[1];

  // Expand args (skip the raw kw tokens -- they expand to themselves).
  const expanded = items.slice(2).map(it => {
    if (it.t === 'kw') return it;
    return expandNode(it, env, ctx);
  });

  const { positional, kwargs } = splitArgs(expanded);

  // Output jacks: (<- (cv-out :1) X). The sink list head is an output-jack
  // family; carry it through as a structured jacksink for the lowerer to
  // range-check and resolve. Reading these in value position is rejected
  // separately in the lowerer.
  const OUTPUT_JACKS = new Set(['cv-out', 'audio-out', 'pulse-out', 'led']);
  let sink;
  if (sinkNode && sinkNode.t === 'list' && sinkNode.items[0]
      && sinkNode.items[0].t === 'sym' && OUTPUT_JACKS.has(sinkNode.items[0].s)) {
    const jack = sinkNode.items[0].s;
    const rest = sinkNode.items.slice(1);
    const exprItems = rest.filter(it => it.t !== 'kw');
    if (exprItems.length > 0) {
      // Computed label: (<- (cv-out sel) X) routes X to the sel-th jack of the
      // family. The selector wraps over the physical set in the lowerer.
      sink = { t: 'jackscatter', jack, selector: expandNode(exprItems[0], env, ctx) };
    } else {
      const labels = rest.filter(it => it.t === 'kw').map(it => it.s);
      sink = { t: 'jacksink', jack, labels };
    }
  } else if (sinkNode && sinkNode.t === 'sym') {
    // Resolve sink: try env lookup; if not found it is a hardware sink sym.
    const r = envLookup(env, sinkNode.s);
    sink = r.found ? r.value : sinkNode;
  } else if (sinkNode) {
    sink = expandNode(sinkNode, env, ctx);
  } else {
    sink = { t: 'sym', s: '?' };
  }

  let value;
  if (positional.length === 1) {
    value = positional[0];
  } else if (positional.length > 1) {
    // Multi-positional cable: (<- buf (vcf :cut ...) (add ...) :per-sample)
    // The first positional is a filter/processing chain; the second is the source.
    // Model as a chain node.
    value = { t: 'chain', stages: positional };
  } else {
    value = { t: 'num', v: 0 };
  }

  // Auto-inject :trig master when sink is a buffer (tape/audio/lens) and no rate kwarg is present.
  // Audio delay buffers (t === 'audio') default to per-sample writes; tape/lens use the master clock.
  // Mirrors CLK_OPS injection for primitive calls (expander.js line 480).
  const sinkIsBuf = sink.t === 'tape' || sink.t === 'audio' || sink.t === 'lens';
  if (sinkIsBuf && !kwargs.trig && !kwargs.hz && !kwargs.bpm && !('per-sample' in kwargs)) {
    if (sink.t === 'audio') {
      kwargs['per-sample'] = { t: 'flag' };
    } else {
      const masterR = envLookup(env, 'master');
      if (masterR.found) kwargs.trig = masterR.value;
    }
  }

  return { sink, value, kwargs };
}

// Load a file, parse it, and bind its top-level defs into env.
// If collectCables is true, top-level (<- ...) forms are stored as raw AST in ctx.preludeCableForms.
function loadAndBindFile(relpath, env, ctx, collectCables) {
  const text = ctx.loadFile(relpath);
  const forms = read(text);
  processTopLevelForms(forms, env, ctx, collectCables);
}

// Process top-level forms: def, use, fn-def, patch are handled here.
function processTopLevelForms(forms, env, ctx, collectCables) {
  for (const form of forms) {
    if (form.t !== 'list' || !form.items[0] || form.items[0].t !== 'sym') continue;
    const head = form.items[0].s;

    if (head === 'def') {
      bindDef(form, env, ctx);
    }

    // SPEC: prelude top-level (<- SINK EXPR) are default cables; stored raw for
    // deferred expansion in the patch's env.
    if (collectCables && head === '<-') {
      ctx.preludeCableForms.push(form);
    }
  }
}

function expand(astForms, { loadFile }) {
  const report = {
    cables: [],
    unresolvedSyms: new Set(),
    unknownOps: new Set(),
  };
  const ctx = { report, loadFile, localCables: [], preludeCableForms: [] };

  // Build prelude env; collect top-level (<- ...) forms as default cables.
  const rootEnv = makeEnv(null);
  ctx.rootEnv = rootEnv;
  try {
    loadAndBindFile('prelude.loupe', rootEnv, ctx, true);
  } catch (e) {
    report.preludeError = e.message;
  }

  // Patch-level env extends prelude.
  const patchEnv = makeEnv(rootEnv);

  for (const form of astForms) {
    if (form.t !== 'list' || !form.items[0] || form.items[0].t !== 'sym') continue;
    const head = form.items[0].s;

    if (head === 'use') {
      const pathSym = form.items[1];
      const relpath = 'patches/' + (pathSym && pathSym.s) + '.loupe';
      try {
        loadAndBindFile(relpath, patchEnv, ctx);
      } catch (_e) {
        report.unknownOps.add('use:' + (pathSym && pathSym.s));
      }
      continue;
    }

    if (head === 'def') {
      // Top-level def outside patch (e.g. drum-kit.loupe has fn defs before (patch ...)).
      bindDef(form, patchEnv, ctx);
      continue;
    }

    if (head === 'patch' || head === 'computer-patch' || head === 'vst-patch' || head === 'midi-patch') {
      expandPatchBody(form.items.slice(1), patchEnv, report, ctx);
      continue;
    }
  }

  // Flush cables emitted inside fn bodies (buffer writes, etc.) into the main
  // cable list so the lowerer generates their recordhead slots.
  for (const c of ctx.localCables) report.cables.push(c);

  return report;
}

function expandPatchBody(bodyForms, env, report, ctx) {
  const localEnv = makeEnv(env);
  const claimedSinks = new Set();

  for (const form of bodyForms) {
    if (form.t !== 'list' || !form.items[0] || form.items[0].t !== 'sym') continue;
    const head = form.items[0].s;

    if (head === 'def') {
      bindDef(form, localEnv, ctx);
      continue;
    }

    if (head === '<-') {
      const cable = expandCableForm(form, localEnv, ctx);
      // Track the sink name so we can suppress prelude defaults for it.
      const sinkName = cable.sink && cable.sink.t === 'sym' ? cable.sink.s : null;
      if (sinkName) claimedSinks.add(sinkName);
      report.cables.push(cable);
      continue;
    }
  }

  // Inject prelude default cables for sinks not claimed by the patch.
  // SPEC: expanded in the patch's localEnv so (trig) resolves to the patch's master.
  for (const form of ctx.preludeCableForms) {
    const sinkSym = form.items[1];
    const sinkName = sinkSym && sinkSym.t === 'sym' ? sinkSym.s : null;
    if (sinkName && claimedSinks.has(sinkName)) continue;
    const cable = expandCableForm(form, localEnv, ctx);
    report.cables.push(cable);
  }
}

module.exports = { expand };
