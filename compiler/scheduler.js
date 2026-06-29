'use strict';

// Scheduler: global topological sort, dual-core partition, single-writer verification.
// Input: lowered graph. There is no rate classification: every slot runs each
// sample and the runtime skips the unchanged ones.
// Output: { sampleRate, writerMap, violations, terminalFeedReport, ... }
//   sampleRate: [{ slotId, core }] in one global topological order (all slots)
//   writerMap: Map< `${slotId}.${field}`, slotId >
//   violations: single-writer violation list (empty if clean)
//   terminalFeedReport: [{ slotId, kernel, core, jack, accepted }]: one entry per
//       source slot feeding a terminal write; accepted=true if moved to Core 0

// ---------------------------------------------------------------------------
// Stub-kernel registry.
//
// Each entry has:
//   kernel:    string, the op_ name
//   gap:       human-readable name of the gap (from language-gaps.md)
//   predicate: fn(slot) -> bool, true if this slot instance is the stub case.
//              For "always" stubs use () => true.
//
// schedule() scans all slots after the budget check.
// Any match throws with the offending slot list.
// ---------------------------------------------------------------------------
const STUB_KERNELS = [
  {
    // thru with :on: the expander inlines op-lens calls so the full pipeline
    // never emits op_thru with in[2]. This entry catches manual graph construction
    // or future lowering paths that miss the expander rewrite.
    kernel: 'op_thru',
    gap: 'thru :on op-lens application',
    predicate: slot => slot.in.length >= 3 && slot.in[2] != null,
  },
  {
    // op_record with no :on path means the lowerer missed a rewrite to recordhead_*.
    kernel: 'op_record',
    gap: 'op_record stub if not rewired',
    predicate: () => true,
  },
  {
    kernel: 'op_stub',
    gap: 'sentinel: op_stub should never appear in lowered output',
    predicate: () => true,
  },
];

const BUDGET_PER_SAMPLE = 5208; // 250 MHz / 48 kHz
const OVERHEAD_CORE0 = 2000;    // ring doorbell, walk, publish shadows, commit, drive outputs
const OVERHEAD_CORE1 = 500;     // doorbell IRQ entry, walk, publish shadows, signal done

// --- Partition tuning knobs (TUNABLE) ----------------------------------------
// These are deliberately approximate. The real per-sample overheads will be
// measured on hardware later (cost.py / perf probe); they only need to be in the
// right ballpark to balance the split.
//
// IMBALANCE_BOUND: edge-reduction local search may move a slot across cores
//   only while |c0-c1|/total stays at or below this fraction. Keeps the split
//   roughly balanced while trimming cross-core edges.
const IMBALANCE_BOUND = 0.10;
// TERMINAL_FEED_IMBALANCE: the terminal-feed pass colocates a jack writer with
//   its feeder on Core 0 and tolerates a looser bound than IMBALANCE_BOUND,
//   since saving a cross-core hop on an output is worth a heavier Core 0.
const TERMINAL_FEED_IMBALANCE = 0.20;

// Per-kernel cost in REAL hardware cycles, measured on the card by the delta method
// (chain N instances, marginal walk cycles per added instance via cli perf; see
// tools/calibrate-cost.js). The ~133 floor is the per-slot dispatch cost in step_slot
// (the skip-check + indirect call) before any kernel math; unmeasured kernels default
// to it in costOf(). Re-measure if the runtime hot loop or clock changes.
const CYCLE_COST = {
  op_saw: 70, op_square: 95, op_triangle: 50, op_sine: 64, op_phasor: 53,
  op_lpf: 51, op_hpf: 54, op_average: 51, op_slew: 51, op_lpg: 74, op_envfollow: 54,
  op_vcf: 84,
  op_wavefold: 69, op_crush: 42, op_saturate: 80, op_ring: 73, op_vca: 73,
  op_schmitt: 38, op_envelope: 64, op_noise: 43,
  op_kick: 185, op_snare: 193, op_hat: 170,
  op_euclid: 55, op_every: 46, op_turns: 43, op_counter: 44,
  op_random: 45, op_chance: 45, op_walk: 47, op_follow: 70,
  op_gate: 45, op_edge: 42, op_fall: 45, op_diff: 36, op_toggle: 40, op_hold: 37,
  op_z1: 35, op_mix2: 40, op_window: 40, op_add_sat: 38, op_sub_sat: 38,
  // Estimates (buffer/memory ops not directly chainable; floor + addressing work).
  op_wave: 112, op_wave_drumrack: 112, op_tap: 82,
  op_recordhead_per_sample: 102, op_recordhead_per_cell: 102, op_recordhead_gated: 102,
  op_recordhead_len_capped: 102, op_recordhead_len_capped_gated: 102,
  op_step: 62, op_onsets: 62, op_gates: 62, op_hits: 62,
  op_snap: 82, op_thru: 52, op_degree: 62, op_pitch: 62,
};

const DISPATCH_FLOOR = 35; // per-slot overhead before kernel math (step_slot), post skip-check removal

function costOf(kernel) {
  return CYCLE_COST[kernel] ?? DISPATCH_FLOOR;
}

// Topological sort of the slot list. Stable (by slot id) for determinism.
// Producer-before-consumer order within a core is REQUIRED: same-core reads see
// the producer's fresh value this sample. Cross-core reads are unit-delayed via a
// shadow published at the sample boundary (snapshot_apply wires cross-core inputs
// to the producer's shadow; runtime publishes shadows after both core walks), so
// cross-core walk order does not affect the result.
function topoSort(slots) {
  const inGroup = new Set(slots.map(s => s.id));
  const order = [];
  const visited = new Set();

  function visit(slot) {
    if (visited.has(slot.id)) return;
    visited.add(slot.id);
    // Visit dependencies that are in the same group first.
    for (const ref of slot.in) {
      if (ref.kind === 'slot' && inGroup.has(ref.id)) {
        const dep = slots.find(s => s.id === ref.id);
        if (dep) visit(dep);
      }
    }
    order.push(slot);
  }

  // Process in id order for determinism.
  const sorted = [...slots].sort((a, b) => a.id - b.id);
  for (const slot of sorted) visit(slot);
  return order;
}

// Cost-balanced greedy: sort by cost descending, assign to lighter core.
// pinnedToCore0: Set of slot ids that must land on Core 0 (terminal-feeding
// slots) so runtime_drive_terminals (Core 0 only) reads their values without a
// 1-sample cross-core lag on the most audible outputs.
function greedyBalance(slots, pinnedToCore0) {
  const pinned = pinnedToCore0 || new Set();
  const byCost = [...slots].sort((a, b) => costOf(b.kernel) - costOf(a.kernel));
  const coreLoad = [0, 0];
  const coreOf = new Map();

  // First pass: pin terminal-feeding slots to Core 0.
  for (const slot of byCost) {
    if (pinned.has(slot.id)) {
      coreOf.set(slot.id, 0);
      coreLoad[0] += costOf(slot.kernel);
    }
  }
  // Second pass: assign remaining slots to the lighter core.
  for (const slot of byCost) {
    if (!coreOf.has(slot.id)) {
      const core = coreLoad[0] <= coreLoad[1] ? 0 : 1;
      coreOf.set(slot.id, core);
      coreLoad[core] += costOf(slot.kernel);
    }
  }

  return coreOf;
}

// Sum costOf over a slot set on each core, given a coreOf map.
function coreLoads(slots, coreOf) {
  const load = [0, 0];
  for (const slot of slots) load[coreOf.get(slot.id) ?? 0] += costOf(slot.kernel);
  return load;
}

// Count cross-core edges: producer->consumer slot refs whose cores differ.
// Each differing (consumer, input-ref-to-a-slot-in-this-group) pair is one edge.
function crossCoreEdges(slots, coreOf) {
  const inGroup = new Set(slots.map(s => s.id));
  let edges = 0;
  for (const slot of slots) {
    const cc = coreOf.get(slot.id) ?? 0;
    for (const ref of (slot.in || [])) {
      if (ref.kind === 'slot' && inGroup.has(ref.id)) {
        const pc = coreOf.get(ref.id) ?? 0;
        if (pc !== cc) edges++;
      }
    }
  }
  return edges;
}

// Local-search pass: starting from a cost-balanced split, move single slots to
// the other core when the move strictly reduces the cross-core edge count and
// keeps |c0-c1|/total <= IMBALANCE_BOUND. Pinned slots stay on Core 0. Repeats
// until a pass makes no improving move. Co-minimises imbalance and edges.
// Recomputes edges per candidate move (O(slots*edges) per pass): compile-time
// only, off the audio path, and bounded by LENS_MAX_SLOTS (256).
function edgeMinimisePass(slots, coreOf, pinnedToCore0) {
  const pinned = pinnedToCore0 || new Set();
  const load = coreLoads(slots, coreOf);
  const total = load[0] + load[1];
  if (total === 0) return coreOf;

  let improved = true;
  while (improved) {
    improved = false;
    for (const slot of slots) {
      if (pinned.has(slot.id)) continue;
      const from = coreOf.get(slot.id) ?? 0;
      const to = from ^ 1;
      const cost = costOf(slot.kernel);

      // Imbalance after the tentative move.
      const nl0 = from === 0 ? load[0] - cost : load[0] + cost;
      const nl1 = from === 1 ? load[1] - cost : load[1] + cost;
      const imbal = Math.abs(nl0 - nl1) / total;
      if (imbal > IMBALANCE_BOUND) continue;

      const before = crossCoreEdges(slots, coreOf);
      coreOf.set(slot.id, to);
      const after = crossCoreEdges(slots, coreOf);
      if (after < before) {
        load[0] = nl0; load[1] = nl1;
        improved = true;
      } else {
        coreOf.set(slot.id, from); // revert
      }
    }
  }
  return coreOf;
}

// Partition the slot list across the two cores and return its coreOf map.
//
// Use both cores whenever there is parallel work to place on Core 1. The split
// is race-free by construction: cross-core reads are unit-delayed through the
// shadow published at the sample boundary, so the result is independent of which
// core finishes first (dualcore-check verifies c0first == c1first). This trades a
// 1-sample lag on cross-core outputs for running the graph on both cores. A patch
// too small to fill a second core leaves c1 empty (dual=false); the runtime still
// walks it through the same dual path, Core 1 just has nothing to do.
function decidePartition(slots, pinnedToCore0) {
  const dualCoreOf = greedyBalance(slots, pinnedToCore0);
  edgeMinimisePass(slots, dualCoreOf, pinnedToCore0);
  const [, c1] = coreLoads(slots, dualCoreOf);

  if (c1 > 0) return { coreOf: dualCoreOf, dual: true };

  const coreOf = new Map();
  for (const slot of slots) coreOf.set(slot.id, 0);
  return { coreOf, dual: false };
}

// Build the ordered [{slotId, core}] list preserving topological order.
function buildList(sortedSlots, coreOf) {
  return sortedSlots.map(s => ({ slotId: s.id, core: coreOf.get(s.id) ?? 0 }));
}

// Single-writer verifier.
// Each slot's NodeState fields are declared in slot.meta.state.
// The verifier checks that no (slotId, field) pair is claimed by more than one slot.
// Since each slot owns its own state by construction, the check is:
//   for all slot s, for all field f in s.meta.state: (s.id, f) is unique.
// We also check that slot.out always points to the slot's OWN state (s.out.slotId === s.id).
function buildWriterMap(slots) {
  const writerMap = new Map(); // key `${slotId}.${field}` -> ownerSlotId
  const violations = [];

  for (const slot of slots) {
    // Check out field ownership.
    if (slot.out && slot.out.slotId !== slot.id) {
      violations.push({
        slot: slot.id,
        field: slot.out.field,
        otherSlot: slot.out.slotId,
        kind: 'cross-slot-out',
      });
    }

    for (const field of (slot.meta.state || [])) {
      const key = `${slot.id}.${field}`;
      if (writerMap.has(key)) {
        violations.push({
          slot: slot.id,
          field,
          otherSlot: writerMap.get(key),
          kind: 'duplicate-state-field',
        });
      } else {
        writerMap.set(key, slot.id);
      }
    }
  }

  return { writerMap, violations };
}

// Terminal-feed priority pass (sample rate only).
// For each sample-rate slot that feeds a terminal-write slot directly, try to
// move it to Core 0. Skip if the move would make Core 0's cycle total more than
// 20% heavier than Core 1's.
// SPEC: terminal-write slots themselves are already pinned to Core 0 by partition().
// Moving their source slots to Core 0 avoids an extra cross-core read lag on the
// most audible outputs.
function terminalFeedPass(sortedSlots, coreOf, terminalWriteIds) {
  const slotMap = new Map(sortedSlots.map(s => [s.id, s]));

  // Compute current per-core cycle load.
  const coreLoad = [0, 0];
  for (const slot of sortedSlots) {
    const core = coreOf.get(slot.id) ?? 0;
    coreLoad[core] += costOf(slot.kernel);
  }

  // Build set of source slot ids (direct inputs to terminal-write slots).
  const terminalSourceIds = new Set();
  const sourceToJack = new Map(); // slotId -> jack name(s) for reporting
  for (const slot of sortedSlots) {
    if (!terminalWriteIds.has(slot.id)) continue;
    for (const ref of (slot.in || [])) {
      if (ref.kind === 'slot') {
        terminalSourceIds.add(ref.id);
        const jacks = sourceToJack.get(ref.id) || [];
        // Recover jack from kernel name: op_terminal_write_audio_out_1 -> audio-out-1.
        const jack = slot.kernel.replace('op_terminal_write_', '').replace(/_/g, '-');
        jacks.push(jack);
        sourceToJack.set(ref.id, jacks);
      }
    }
  }

  const report = [];

  for (const slotId of terminalSourceIds) {
    const slot = slotMap.get(slotId);
    const currentCore = coreOf.get(slotId) ?? 0;
    const jacks = sourceToJack.get(slotId) || [];

    if (currentCore === 0) {
      // Already on Core 0, no action needed.
      report.push({ slotId, kernel: slot ? slot.kernel : '?', core: 0, jacks, accepted: true, moved: false });
      continue;
    }

    // Simulate moving to Core 0: check 20% imbalance threshold.
    const cost = costOf(slot ? slot.kernel : 'unknown');
    const newLoad0 = coreLoad[0] + cost;
    const newLoad1 = coreLoad[1] - cost;
    const totalLoad = newLoad0 + newLoad1;
    // Reject if Core 0 would be more than TERMINAL_FEED_IMBALANCE heavier.
    const imbalanced = totalLoad > 0 && (newLoad0 - newLoad1) / totalLoad > TERMINAL_FEED_IMBALANCE;

    if (imbalanced) {
      // SPEC: cross-core lag accepted here; Core 0 would become too heavy.
      report.push({ slotId, kernel: slot ? slot.kernel : '?', core: 1, jacks, accepted: false, moved: false });
    } else {
      coreOf.set(slotId, 0);
      coreLoad[0] = newLoad0;
      coreLoad[1] = newLoad1;
      report.push({ slotId, kernel: slot ? slot.kernel : '?', core: 0, jacks, accepted: true, moved: true });
    }
  }

  return report;
}

// Returns per-core cycle budget report.
// kernelOfSlot: Map<slotId, kernelName>. The runtime always runs the dual path
// (Core 0 rings Core 1 each sample), so both cores carry their doorbell overhead
// even when Core 1 is empty.
function verifyBudget(sampleRate, kernelOfSlot) {
  const overhead = [OVERHEAD_CORE0, OVERHEAD_CORE1];
  const sr = [0, 0];
  for (const entry of sampleRate) {
    const k = kernelOfSlot.get(entry.slotId) ?? 'unknown';
    sr[entry.core] += costOf(k);
  }

  const results = [0, 1].map(c => {
    const total = overhead[c] + sr[c];
    return { sr: sr[c], overhead: overhead[c], total, budget: BUDGET_PER_SAMPLE, ok: total <= BUDGET_PER_SAMPLE };
  });

  return {
    core0: results[0],
    core1: results[1],
    ok: results[0].ok && results[1].ok,
  };
}

function schedule(graph) {
  // One global topological order over ALL slots. No sample/control split: the
  // runtime runs every slot each sample and skips the unchanged ones. Producers
  // precede consumers so an intra-core read sees this sample's fresh value.
  const sorted = topoSort(graph.slots);

  // Terminal-write slot ids (op_terminal_write_*) are pinned to Core 0.
  const terminalWriteIds = new Set(graph.terminals.map(t => t.slotId));

  const decision = decidePartition(sorted, terminalWriteIds);
  const coreOf = decision.coreOf;
  const dual = decision.dual;

  // Cross-core edge counts before/after the edge-minimise pass, for reporting.
  let edgesBefore = 0, edgesAfter = 0;
  if (dual) {
    const baseline = greedyBalance(sorted, terminalWriteIds);
    edgesBefore = crossCoreEdges(sorted, baseline);
    edgesAfter  = crossCoreEdges(sorted, coreOf);
  }

  const terminalFeedReport = terminalFeedPass(sorted, coreOf, terminalWriteIds);

  // One ordered slot list over all slots.
  const sampleRate = buildList(sorted, coreOf);

  const { writerMap, violations } = buildWriterMap(graph.slots);

  const kernelOfSlot = new Map(graph.slots.map(s => [s.id, s.kernel]));
  const budget = verifyBudget(sampleRate, kernelOfSlot);

  // Over-budget is a runtime performance concern, not a compile error: the patch
  // still produces a valid graph and the card runs it (degrading if truly over). So
  // report it (budget.ok=false, surfaced to the caller / cli) but do not throw.
  if (!budget.ok) {
    const parts = [];
    for (const [label, r] of [['core0', budget.core0], ['core1', budget.core1]]) {
      if (!r.ok) parts.push(`${label}: sr=${r.sr}+overhead=${r.overhead}=${r.total} > budget=${r.budget}`);
    }
    budget.warning = `cycle budget exceeded: ${parts.join('; ')}`;
  }

  // Stub-kernel scan: refuse to schedule any patch that contains a known stub.
  // This runs after the budget check so the budget error message reaches the user first.
  const stubHits = [];
  for (const slot of graph.slots) {
    for (const entry of STUB_KERNELS) {
      if (slot.kernel === entry.kernel && entry.predicate(slot)) {
        stubHits.push({ slotId: slot.id, kernel: slot.kernel, gap: entry.gap });
      }
    }
  }
  if (stubHits.length > 0) {
    const lines = stubHits.map(
      h => `  slot ${h.slotId}: ${h.kernel}, gap: "${h.gap}"`
    );
    throw new Error(
      `patch uses unimplemented language features (see SPECS/language-gaps.md):\n` +
      lines.join('\n')
    );
  }

  return {
    sampleRate, writerMap, violations, terminalFeedReport, budget,
    dual, edgesBefore, edgesAfter,
  };
}

module.exports = { schedule, costOf, verifyBudget, crossCoreEdges };
