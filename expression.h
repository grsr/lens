// expression.h: the compiled Loupe program: Nodes, the Graph, and Terminals.

#pragma once

#include <stdint.h>
#include "tape.h"

namespace loupe {

// Kind list (names, signatures, intervals) lives in nodes.js; node_kinds.h is generated.
// Numbering is the save format: new kinds append, reordering breaks saves.
#include "node_kinds.h"

enum NodeKind : int8_t
{
#define X(sym, name) sym,
    LOUPE_NODE_KINDS(X)
#undef X
    NODE_KIND_COUNT
};

struct Node
{
    NodeKind kind;
    int16_t  array_idx;     // Tape handle / literal handle, or -1
    int16_t  in_a;          // upstream node index, or -1
    int16_t  in_b;          // upstream node index, or -1
    value_t  param;         // node-specific literal, a 12-bit VALUE
    int16_t  param_from;    // upstream node index for live param, or -1
    int16_t  clock_from;    // upstream node index for clock, or -1 (master beat)
    int16_t  branch_start;  // first branch node index (switch/weave), or -1
    int16_t  branch_count;  // number of branches (switch/weave), or 0
    int8_t   is_signal;     // 1 = bipolar SIGNAL, 0 = unipolar VALUE
    int32_t  interval;      // largest safe recompute interval; 1 = audio, kNever = never
};

// Sentinel for const nodes that never recompute. Mirrors compile.js NEVER.
static constexpr int32_t kNever = 0x7FFFFFFF;

static constexpr int kNodePool = 512;       // MUST match compile.js
static constexpr int kMaxGraphLiterals = 64; // MUST match KMAXGRAPHLITERALS in compile.js
static constexpr int kNumOutputs = 6;
static constexpr int kMaxRecordheads = 8;

struct LiteralTape
{
    uint32_t start;      // offset into the pool [kPoolStart, kBufferBytes)
    uint32_t length;
};

struct Graph
{
    Node        nodes[kNodePool];
    LiteralTape literals[kMaxGraphLiterals];
    int16_t     length;          // number of nodes used (0..kNodePool)
    int16_t     literal_count;   // number of literal tapes (0..kMaxGraphLiterals)
};

struct Terminals
{
    int16_t jack[kNumOutputs];           // output jacks (precision CV, audio, pulse)
    int16_t led[6];                      // LED brightness sources
    int16_t reset, clock_in;             // transport: reset pulse, external clock
    int16_t rec[kMaxRecordheads];        // recordhead stream sources
    int8_t  rec_tape[kMaxRecordheads];   // tape each recordhead writes (-1 = unused)
    int8_t  rec_count;                   // active recordheads
};

}  // namespace loupe
