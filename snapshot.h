// snapshot.h: one patch serialization. SysEx wire == flash save == embedded boot
// default == what compile.js emits. Field-by-field little-endian; field order MUST
// mirror compile.js serializeSnapshot exactly.

#pragma once

#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include "expression.h"

namespace loupe {

static constexpr uint8_t kSnapshotMagic[4] = { 'L', 'E', 'N', 'S' };

// Cursors: out-of-bounds trips `ok`, further ops become no-ops; check once at end.
struct SnapshotWriter
{
    uint8_t* p;
    uint8_t* end;
    bool     ok = true;

    SnapshotWriter(uint8_t* buf, size_t cap) : p(buf), end(buf + cap) {}
    size_t written(uint8_t* base) const { return (size_t)(p - base); }

    void bytes(const void* src, size_t n)
    {
        if (!ok) return;
        if (p + n > end) { ok = false; return; }
        memcpy(p, src, n); p += n;
    }
    void u8(uint8_t v)  { bytes(&v, 1); }
    void i8(int8_t v)   { uint8_t b = (uint8_t)v; u8(b); }
    void u16(uint16_t v){ uint8_t b[2] = { (uint8_t)v, (uint8_t)(v >> 8) }; bytes(b, 2); }
    void i16(int16_t v) { u16((uint16_t)v); }
    void u32(uint32_t v){ uint8_t b[4] = { (uint8_t)v, (uint8_t)(v >> 8), (uint8_t)(v >> 16), (uint8_t)(v >> 24) }; bytes(b, 4); }
    void i32(int32_t v) { u32((uint32_t)v); }
};

struct SnapshotReader
{
    const uint8_t* p;
    const uint8_t* end;
    bool           ok = true;

    SnapshotReader(const uint8_t* buf, size_t len) : p(buf), end(buf + len) {}

    void bytes(void* dst, size_t n)
    {
        if (!ok) return;
        if (p + n > end) { ok = false; if (dst) memset(dst, 0, n); return; }
        memcpy(dst, p, n); p += n;
    }
    uint8_t  u8()  { uint8_t v = 0; bytes(&v, 1); return v; }
    int8_t   i8()  { return (int8_t)u8(); }
    uint16_t u16() { uint8_t b[2] = {0,0}; bytes(b, 2); return (uint16_t)(b[0] | (b[1] << 8)); }
    int16_t  i16() { return (int16_t)u16(); }
    uint32_t u32() { uint8_t b[4] = {0,0,0,0}; bytes(b, 4); return (uint32_t)b[0] | ((uint32_t)b[1] << 8) | ((uint32_t)b[2] << 16) | ((uint32_t)b[3] << 24); }
    int32_t  i32() { return (int32_t)u32(); }
};

inline void blob_write_graph(SnapshotWriter& w, const Graph& g)
{
    const int len = (g.length < 0) ? 0 : (g.length > kNodePool ? kNodePool : g.length);
    const int lc  = (g.literal_count < 0) ? 0 : (g.literal_count > kMaxGraphLiterals ? kMaxGraphLiterals : g.literal_count);
    w.u16((uint16_t)len);
    w.u8((uint8_t)lc);
    for (int i = 0; i < lc; ++i) { w.u32(g.literals[i].start); w.u32(g.literals[i].length); }
    for (int i = 0; i < len; ++i)
    {
        const Node& f = g.nodes[i];
        w.u8((uint8_t)f.kind);
        w.i16(f.array_idx);
        w.i16(f.in_a);
        w.i16(f.in_b);
        w.i16(f.param);
        w.i16(f.param_from);
        w.i16(f.clock_from);
        w.i16(f.branch_start);
        w.i16(f.branch_count);
        w.u8((uint8_t)f.is_signal);
        w.u32((uint32_t)f.interval);
    }
}

inline void blob_read_graph(SnapshotReader& r, Graph& g)
{
    g = Graph{};                           // zero unused nodes/literals
    int len = r.u16();
    int lc  = r.u8();
    if (len > kNodePool || lc > kMaxGraphLiterals) { r.ok = false; return; }
    g.length = (int16_t)len;
    g.literal_count = (int16_t)lc;
    for (int i = 0; i < lc; ++i) { g.literals[i].start = r.u32(); g.literals[i].length = r.u32(); }
    for (int i = 0; i < len; ++i)
    {
        Node& f = g.nodes[i];
        f.kind         = (NodeKind)r.u8();
        f.array_idx    = r.i16();
        f.in_a         = r.i16();
        f.in_b         = r.i16();
        f.param        = r.i16();
        f.param_from   = r.i16();
        f.clock_from   = r.i16();
        f.branch_start = r.i16();
        f.branch_count = r.i16();
        f.is_signal    = r.i8();
        f.interval       = (int32_t)r.u32();
    }
}

inline void blob_write_terminals(SnapshotWriter& w, const Terminals& t, int /*tape_count*/)
{
    for (int j = 0; j < kNumOutputs; ++j) w.i16(t.jack[j]);
    for (int l = 0; l < 6; ++l)           w.i16(t.led[l]);
    w.i16(t.reset); w.i16(t.clock_in);
    w.u8((uint8_t)t.rec_count);
    for (int r = 0; r < t.rec_count; ++r) { w.i8(t.rec_tape[r]); w.i16(t.rec[r]); }
}

inline void blob_read_terminals(SnapshotReader& r, Terminals& t, int /*tape_count*/)
{
    t = Terminals{};
    for (int j = 0; j < kNumOutputs; ++j) t.jack[j] = r.i16();
    for (int l = 0; l < 6; ++l)           t.led[l]  = r.i16();
    t.reset = r.i16(); t.clock_in = r.i16();
    for (int i = 0; i < kMaxRecordheads; ++i) { t.rec[i] = -1; t.rec_tape[i] = -1; }
    uint8_t rc = r.u8();
    if (!r.ok || rc > kMaxRecordheads) { r.ok = false; return; }
    t.rec_count = (int8_t)rc;
    for (int i = 0; i < rc; ++i) { t.rec_tape[i] = r.i8(); t.rec[i] = r.i16(); }
}

// Magic + version gate. No migrations: version mismatch rejects wholesale.
inline bool blob_check_header(SnapshotReader& r, uint32_t accept_version)
{
    uint8_t m[4]; r.bytes(m, 4);
    if (!r.ok || memcmp(m, kSnapshotMagic, 4) != 0) { r.ok = false; return false; }
    uint32_t v = r.u32();
    if (!r.ok || v != accept_version) { r.ok = false; return false; }
    return true;
}

inline void blob_write_header(SnapshotWriter& w, uint32_t version)
{
    w.bytes(kSnapshotMagic, 4);
    w.u32(version);
}

// Validity probe (magic + version) without decoding. Used at boot.
inline bool snapshot_validate(const uint8_t* buf, size_t len, uint32_t accept_version)
{
    if (!buf || len < 8) return false;
    SnapshotReader r(buf, len);
    return blob_check_header(r, accept_version);
}

// SnapshotView: pointers into the caller's live state; encode/decode read/write through them.
struct SnapshotView
{
    uint8_t*    control;        // live_ control region, kControlBytes long
    uint16_t    control_len;    // populated extent

    Tape*       tapes;          // [kMaxTapes]
    uint8_t     tape_count;

    int32_t*    master_main;
    int32_t*    master_x;
    int32_t*    master_y;
    uint8_t     active_page;

    Graph*      graph;
    Terminals*  term;
};

inline void snapshot_encode(SnapshotWriter& w, const SnapshotView& v, uint32_t version)
{
    blob_write_header(w, version);
    w.u16(v.control_len);
    w.bytes(v.control, v.control_len);
    w.u8(v.tape_count);
    for (int i = 0; i < v.tape_count; ++i)
    {
        const Tape& t = v.tapes[i];
        w.u32(t.start); w.u32(t.length);
        w.i8(t.drift_offset);
        w.u8(t.y_mod_enabled ? 1 : 0); w.u8(t.variety_shape); w.u8(t.frozen ? 1 : 0); w.u8(t.input_role);
        w.u32(t.clock_div);
        w.i32(t.main_stored); w.i32(t.x_stored); w.i32(t.y_stored);
    }
    w.i32(*v.master_main); w.i32(*v.master_x); w.i32(*v.master_y);
    w.u8(v.active_page);
    blob_write_graph(w, *v.graph);
    blob_write_terminals(w, *v.term, v.tape_count);
}

// Decode into the view's live members. Returns false on bounds/version failure.
inline bool snapshot_decode(SnapshotReader& r, SnapshotView& v, uint32_t accept_version)
{
    if (!blob_check_header(r, accept_version)) return false;

    uint16_t clen = r.u16();
    if (!r.ok || clen > kControlBytes) { r.ok = false; return false; }
    memset(v.control, 0, kControlBytes);
    r.bytes(v.control, clen);
    v.control_len = clen;

    uint8_t tc = r.u8();
    if (!r.ok || tc > kMaxTapes) { r.ok = false; return false; }
    v.tape_count = tc;
    for (int i = 0; i < kMaxTapes; ++i) v.tapes[i] = Tape{};
    for (int i = 0; i < tc; ++i)
    {
        Tape& t = v.tapes[i];
        t.start = r.u32(); t.length = r.u32();
        t.drift_offset = r.i8();
        t.y_mod_enabled = r.u8() != 0; t.variety_shape = r.u8(); t.frozen = r.u8() != 0; t.input_role = r.u8();
        t.clock_div = r.u32();
        t.main_stored = r.i32(); t.x_stored = r.i32(); t.y_stored = r.i32();
    }

    *v.master_main = r.i32(); *v.master_x = r.i32(); *v.master_y = r.i32();
    v.active_page = r.u8();

    blob_read_graph(r, *v.graph);
    blob_read_terminals(r, *v.term, tc);

    return r.ok;
}

}  // namespace loupe
