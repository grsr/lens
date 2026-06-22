#include "runtime.h"
#include "kernel_ids.h"
#include <string.h>
#include <stdio.h>

/* pack12: 12-bit cells packed 2-per-3-bytes. */
__attribute__((always_inline))
static inline void pack12_write(uint8_t* buf, uint32_t idx, int32_t val) {
    uint32_t v    = (uint32_t)val & 0xFFFu;
    uint32_t pair = idx >> 1;
    uint32_t base = (pair << 1) + pair;
    if ((idx & 1u) == 0u) {
        buf[base]      = (uint8_t)(v & 0xFFu);
        buf[base + 1u] = (uint8_t)((buf[base + 1u] & 0xF0u) | (v >> 8));
    } else {
        buf[base + 1u] = (uint8_t)((buf[base + 1u] & 0x0Fu) | ((v & 0xFu) << 4));
        buf[base + 2u] = (uint8_t)(v >> 4);
    }
}

/* ---- Tape geometry preservation ---- */
/* Stores the audio buffer lengths from the last successful apply.
   If incoming patch has the same layout, the audio pool is not zeroed,
   letting dub-delay tails ring through a patch swap. */
static uint32_t g_last_audio_lens[LENS_MAX_BUFFERS];
static uint8_t  g_last_audio_count = 0;

/* ---- Static pools ---- */
/* Sizes come from runtime.h. Audio pool is 128 KB: 12-bit cells pack 2 per
   3 bytes, so 128 KB / 1.5 = 87381 cells = 1.82 s @ 48 kHz. */
uint8_t  lens_audio_pool[LENS_AUDIO_BUFFER_BYTES];
uint8_t  lens_control_pool[LENS_CONTROL_BUFFER_BYTES];
uint8_t  lens_nodestate_pool[LENS_NODESTATE_BYTES];
struct Slot   lens_slot_pool[LENS_MAX_SLOTS];
struct Buffer lens_buffer_pool[LENS_MAX_BUFFERS];
struct RuntimeTerminal lens_terminal_pool[LENS_MAX_TERMINALS];
int32_t  lens_const_pool[LENS_CONST_POOL_WORDS];
int32_t  lens_shadow_pool[LENS_MAX_SLOTS];

/* Flat per-core walk-order lists: SR then CR slots for each core. */
struct Slot* lens_core0_flat_ptrs[LENS_MAX_SLOTS];
struct Slot* lens_core1_flat_ptrs[LENS_MAX_SLOTS];

static struct LensRuntime g_runtime;

/* Shared empty-buffer sentinel. A tape op whose buffer input is driven by a
   value (e.g. a dynamically selected tape via thru/lens) is wired here instead
   of at a reinterpreted int32, so it reads length 0 and no-ops rather than
   dereferencing garbage. Stateless demux that picks nothing reads as silence. */
static struct Buffer g_empty_buffer = { (uint8_t*)0, 0 };

/* The input index a kernel reads as a Buffer*, or -1. Used to redirect a
   non-buffer ref at that position to the empty-buffer sentinel. Recordheads
   (write side) are excluded: their tape target is always a real buffer. */
static int buffer_input_index(uint8_t kid) {
    switch (kid) {
        case KID_OP_STEP:   case KID_OP_LOOKUP: case KID_OP_WAVE:
        case KID_OP_TAP:    case KID_OP_SEEK:   case KID_OP_ONSETS:
        case KID_OP_GATES:  case KID_OP_HITS:   case KID_OP_THRU:
        case KID_OP_WAVE_DRUMRACK:
            return 0;
        case KID_OP_DEGREE: case KID_OP_PITCH:
            return 1;
        default:
            return -1;
    }
}

/* ---- Bump allocators ---- */
static size_t   audio_bump;
static size_t   control_bump;
static size_t   nodestate_bump;
static uint16_t slot_bump;
static uint8_t  buffer_bump;
static uint8_t  terminal_bump;
static uint16_t const_bump;

static void* alloc_audio(size_t n) {
    if (audio_bump + n > LENS_AUDIO_BUFFER_BYTES) return NULL;
    void* p = &lens_audio_pool[audio_bump];
    audio_bump += n;
    return p;
}
static void* alloc_control(size_t n) {
    if (control_bump + n > LENS_CONTROL_BUFFER_BYTES) return NULL;
    void* p = &lens_control_pool[control_bump];
    control_bump += n;
    return p;
}
static void* alloc_nodestate(size_t n) {
    if (nodestate_bump + n > LENS_NODESTATE_BYTES) return NULL;
    void* p = &lens_nodestate_pool[nodestate_bump];
    nodestate_bump += n;
    return p;
}

/* ---- CRC-32 IEEE 802.3 (polynomial 0xEDB88320) ---- */
static uint32_t crc32_compute(const uint8_t* buf, size_t len) {
    static uint32_t tbl[256];
    static int ready = 0;
    if (!ready) {
        for (uint32_t i = 0; i < 256; i++) {
            uint32_t c = i;
            for (int j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320u ^ (c >> 1)) : (c >> 1);
            tbl[i] = c;
        }
        ready = 1;
    }
    uint32_t c = 0xFFFFFFFFu;
    for (size_t i = 0; i < len; i++) c = tbl[(c ^ buf[i]) & 0xFF] ^ (c >> 8);
    return c ^ 0xFFFFFFFFu;
}

/* ---- Byte reader ---- */
typedef struct { const uint8_t* p; const uint8_t* end; } Cur;
static int   ok(Cur* c, size_t n) { return (size_t)(c->end - c->p) >= n; }
static uint8_t  u8(Cur* c)  { return *c->p++; }
static uint16_t u16(Cur* c) { uint16_t v=(uint16_t)(c->p[0]|(c->p[1]<<8)); c->p+=2; return v; }
static uint32_t u32(Cur* c) { uint32_t v=c->p[0]|(c->p[1]<<8)|(c->p[2]<<16)|((uint32_t)c->p[3]<<24); c->p+=4; return v; }
static int32_t  i32(Cur* c) { return (int32_t)u32(c); }

/* ---- snapshot_apply ---- */
int snapshot_apply(struct LensRuntime** out_rt, const uint8_t* bytes, size_t len) {
    if (!bytes || len < 20) return -1;

    /* CRC: last 4 bytes; covers everything before. */
    uint32_t stored = (uint32_t)(bytes[len-4]|(bytes[len-3]<<8)|(bytes[len-2]<<16)|((uint32_t)bytes[len-1]<<24));
    if (stored != crc32_compute(bytes, len - 4)) return -2;

    Cur c = { bytes, bytes + len - 4 };

    /* HEADER (16 bytes). */
    if (!ok(&c, 16)) return -1;
    if (c.p[0]!='L'||c.p[1]!='E'||c.p[2]!='N'||c.p[3]!='S'||c.p[4]!='2') return -3;
    c.p += 5;
    u16(&c);                           /* version */
    u16(&c);                           /* flags */
    uint16_t sc  = u16(&c);           /* slot_count */
    u16(&c);                           /* reserved */
    u16(&c);                           /* reserved */
    uint8_t  bc  = u8(&c);            /* buffer_count */
    uint8_t  tc  = u8(&c);            /* terminal_count */
    uint8_t  kc  = u8(&c);            /* kernel_id_count */
    u8(&c);                            /* reserved */

    /* Pool limit checks. */
    if (sc > LENS_MAX_SLOTS)     return -6;
    if (bc > LENS_MAX_BUFFERS)   return -6;
    if (tc > LENS_MAX_TERMINALS) return -6;

    /* Reset bump pointers. */
    audio_bump = control_bump = nodestate_bump = 0;
    slot_bump = buffer_bump = terminal_bump = const_bump = 0;

    /* Clear static runtime. NodeState pool included: every kernel's state
       struct (counters, phase accumulators, last_clk edges) must start at
       zero so a fresh patch begins from a clean state. Without this, a
       stale uint32 counter from a previous patch's sine phase can land in
       a new patch's op_step.counter, sending pack12_read past the end of
       the tape buffer (4 notes in, 5+ notes out). */
    memset(&g_runtime, 0, sizeof(g_runtime));
    memset(lens_slot_pool,     0, sc * sizeof(struct Slot));
    memset(lens_buffer_pool,   0, bc * sizeof(struct Buffer));
    memset(lens_terminal_pool, 0, tc * sizeof(struct RuntimeTerminal));
    memset(lens_nodestate_pool, 0, LENS_NODESTATE_BYTES);

    struct LensRuntime* rt = &g_runtime;
    /* Seed core1_done to a value Core 0's spin will never mistake for "done":
       sample_counter starts at 0, so a zero here would let sample 0 skip the
       wait and read Core 1's outputs before it has walked them. */
    rt->core1_done = 0xFFFFFFFFu;
    rt->slot_count    = sc;
    rt->buffer_count  = bc;
    rt->terminal_count = tc;

    rt->slots     = lens_slot_pool;

    /* KERNEL REGISTRY: build id -> kernel_id array. */
    if (kc > LENS_MAX_KFNS) return -6;
    uint8_t kkids[LENS_MAX_KFNS];
    for (uint8_t i = 0; i < kc; i++) {
        if (!ok(&c, 1)) return -1;
        uint8_t nlen = u8(&c);
        if (!ok(&c, nlen)) return -1;
        char name[64] = {0};
        memcpy(name, c.p, nlen < 63 ? nlen : 63);
        c.p += nlen;
        uint8_t kid = runtime_find_kernel(name);
        if (kid == KID_UNKNOWN) fprintf(stderr, "[apply] stub: %s\n", name);
        kkids[i] = kid;
    }

    /* --- Two-pass slot table parse ---
       Pass 1: compute pool_size and const count, record per-slot offsets.
       Pass 2: wire slots. */

    /* Per-slot pool offset table (walk order -> byte offset in state_pool). */
    static uint32_t soff[LENS_MAX_SLOTS];
    memset(soff, 0, sc * sizeof(uint32_t));

    /* Helper: advance cursor past one slot record, counting pool and const bytes. */
#define PASS1_SLOT(s1_, pool_, nconst_, wi_) \
    do { \
        if (!ok((s1_), 3)) return -1; \
        uint8_t wkid_ = *(s1_)->p++;  /* kernel_id (wire index) */ \
        (s1_)->p++;                    /* core */ \
        uint8_t nc_ = *(s1_)->p++;    /* in_count */ \
        if (nc_ > 5) return -5;        /* slots have at most 5 inputs; reject malformed */ \
        uint8_t rkid_ = (wkid_ < kc) ? kkids[wkid_] : KID_UNKNOWN; \
        soff[(wi_)] = (pool_); \
        (pool_) += runtime_kernel_state_bytes(rkid_); \
        for (uint8_t jj_ = 0; jj_ < nc_; jj_++) { \
            if (!ok((s1_), 1)) return -1; \
            uint8_t tag_ = u8((s1_)); \
            if (tag_ == LENS_TAG_SLOT || tag_ == LENS_TAG_BUFFER || \
                tag_ == LENS_TAG_SLOT_OUT2) { \
                if (!ok((s1_), 2)) return -1; \
                (s1_)->p += 2; \
            } else if (tag_ == LENS_TAG_CONST_U8) { \
                (nconst_)++; \
                if (!ok((s1_), 1)) return -1; \
                (s1_)->p++; \
            } else if (tag_ == LENS_TAG_CONST_I32) { \
                (nconst_)++; \
                if (!ok((s1_), 4)) return -1; \
                (s1_)->p += 4; \
            } else { return -5; } \
        } \
        if (!ok((s1_), 6)) return -1; \
        (s1_)->p += 6; /* out_offset(2) + param0(4) */ \
    } while (0)

    /* Pass 1: walk the flat slot list to size the state pool and count consts. */
    {
        uint32_t pool = 0;
        uint16_t nconst = 0;
        Cur s1 = c;
        for (uint16_t wi = 0; wi < sc; wi++) {
            PASS1_SLOT(&s1, pool, nconst, wi);
        }
        if (nconst > LENS_CONST_POOL_WORDS) return -6;
        rt->state_pool_size = pool;
        rt->state_pool = alloc_nodestate(pool ? pool : 1);
        if (!rt->state_pool) return -6;
        memset(rt->state_pool, 0, pool ? pool : 1);
        rt->const_pool = lens_const_pool;
        memset(lens_const_pool, 0, nconst * sizeof(int32_t));
        rt->const_count = 0;
    }

    /* Pass 2: wire slots. */

    /* Fixup list for buffer in_refs (stack array; 4 per slot worst case). */
    typedef struct { uint16_t wi; uint8_t in_idx; uint16_t buf_id; } BufFix;
    /* A buffer input is always one of the first four refs (in4 only ever carries a
     * value), so four per slot bounds the fixups; sc <= LENS_MAX_SLOTS. */
    static BufFix bfixes[LENS_MAX_SLOTS * 4];
    uint16_t nbfix = 0;

    static int32_t g_zero = 0;

    /* Per-slot core byte; populated in pass 2, used to fill per-core index arrays. */
    static uint8_t slot_core[LENS_MAX_SLOTS];
    memset(slot_core, 0, sc);

    /* Helper: parse one slot record into rt->slots[wi] and wire pointers. */
#define PASS2_SLOT(wi_) \
    do { \
        if (!ok(&c, 3)) return -1; \
        uint8_t kid_ = u8(&c); \
        uint8_t core_ = u8(&c);   /* core: captured for per-core index arrays */ \
        slot_core[(wi_)] = core_; \
        uint8_t nc_ = u8(&c); \
        struct Slot* s_ = &rt->slots[(wi_)]; \
        s_->kernel_id = (kid_ < kc) ? kkids[kid_] : KID_UNKNOWN; \
        s_->out = (void*)(rt->state_pool + soff[(wi_)]); \
        s_->in0 = s_->in1 = s_->in2 = s_->in3 = s_->in4 = (void*)&g_zero; \
        void** inp_[5] = { &s_->in0, &s_->in1, &s_->in2, &s_->in3, &s_->in4 }; \
        for (uint8_t j_ = 0; j_ < nc_ && j_ < 5; j_++) { \
            if (!ok(&c, 1)) return -1; \
            uint8_t tag_ = u8(&c); \
            if (tag_ == LENS_TAG_SLOT) { \
                if (!ok(&c, 2)) return -1; \
                uint16_t ref_wi_ = u16(&c); \
                if (ref_wi_ < sc) \
                    *inp_[j_] = (void*)(rt->state_pool + soff[ref_wi_]); \
            } else if (tag_ == LENS_TAG_SLOT_OUT2) { \
                if (!ok(&c, 2)) return -1; \
                uint16_t ref_wi_ = u16(&c); \
                if (ref_wi_ < sc) \
                    *inp_[j_] = (void*)(rt->state_pool + soff[ref_wi_] + 4); \
            } else if (tag_ == LENS_TAG_BUFFER) { \
                if (!ok(&c, 2)) return -1; \
                uint16_t bid_ = u16(&c); \
                if (nbfix < LENS_MAX_SLOTS * 4) \
                    bfixes[nbfix++] = (BufFix){ (wi_), j_, bid_ }; \
            } else if (tag_ == LENS_TAG_CONST_U8) { \
                if (!ok(&c, 1)) return -1; \
                int32_t v_ = u8(&c); \
                uint16_t ci_ = rt->const_count++; \
                rt->const_pool[ci_] = v_; \
                *inp_[j_] = (void*)&rt->const_pool[ci_]; \
            } else if (tag_ == LENS_TAG_CONST_I32) { \
                if (!ok(&c, 4)) return -1; \
                int32_t v_ = i32(&c); \
                uint16_t ci_ = rt->const_count++; \
                rt->const_pool[ci_] = v_; \
                *inp_[j_] = (void*)&rt->const_pool[ci_]; \
            } else { return -5; } \
        } \
        if (!ok(&c, 6)) return -1; \
        u16(&c);                    /* out_offset: ignored */ \
        s_->param0 = u32(&c); \
        if (runtime_is_hw_leaf(s_->kernel_id)) \
            s_->in0 = (void*)runtime_hw_jack_ptr(s_->param0); \
        if (s_->kernel_id == KID_OP_SCHMITT) { \
            if (nc_ >= 2) s_->param0 |= 1u; \
            if (nc_ >= 3) s_->param0 |= 2u; \
        } \
        if (s_->kernel_id == KID_OP_MORPH) { \
            s_->param0 = nc_;  /* total in-count needed by kernel */ \
        } \
        runtime_slot_wire_fn(s_); \
    } while (0)

    /* Pass 2: every slot in walk order. */
    for (uint16_t wi = 0; wi < sc; wi++) {
        PASS2_SLOT(wi);
    }

    /* --- Flat per-core walk-order lists (slots[] is already in walk order). --- */
    {
        uint16_t n0 = 0, n1 = 0;
        uint8_t hasRh = 0;
        for (uint16_t i = 0; i < sc; i++) {
            uint8_t k = rt->slots[i].kernel_id;
            if (k >= KID_OP_RECORDHEAD_PER_SAMPLE && k <= KID_OP_RECORDHEAD_LEN_CAPPED_GATED) hasRh = 1;
            if (slot_core[i] == 0) lens_core0_flat_ptrs[n0++] = &rt->slots[i];
            else                   lens_core1_flat_ptrs[n1++] = &rt->slots[i];
        }
        rt->core0_slots = lens_core0_flat_ptrs; rt->core0_count = n0;
        rt->core1_slots = lens_core1_flat_ptrs; rt->core1_count = n1;
        rt->dual_active = (n1 > 0) ? 1u : 0u;
        rt->has_recordhead = hasRh;
    }

    /* --- Cross-core shadow build ---
       Each core's slot list is already in producer-before-consumer order, so
       intra-core reads stay live. A consumer that reads a producer on the OTHER
       core would otherwise see a value whose freshness depends on core walk
       order (a race). Redirect such reads to a per-producer shadow that is
       republished once per sample at the boundary, yielding a deterministic
       one-sample lag.

       A consumer input inN equals state_pool + soff[P] for the value of slot P,
       or state_pool + soff[P] + 4 for a +4 second-output read (TAG_SLOT_OUT2). */
    rt->xcore_count = 0;
    {
        uint8_t* base = rt->state_pool;
        /* Per-producer shadow index, -1 = none yet (dedup across consumers). */
        static int16_t shadow_idx[LENS_MAX_SLOTS];
        for (uint16_t i = 0; i < sc; i++) shadow_idx[i] = -1;

        for (uint16_t si = 0; si < sc; si++) {
            uint8_t score = slot_core[si];
            void** inp[5] = { &rt->slots[si].in0, &rt->slots[si].in1,
                              &rt->slots[si].in2, &rt->slots[si].in3,
                              &rt->slots[si].in4 };
            for (uint8_t j = 0; j < 5; j++) {
                int32_t* in = (int32_t*)*inp[j];
                if (!in) continue;
                size_t off = (size_t)((uint8_t*)in - base);
                if ((uint8_t*)in < base || off >= rt->state_pool_size) continue;

                /* Find producer P: a value read has off == soff[P]; a +4 field read
                   (recordhead head_pos, phasor/follow tick) has off == soff[P] + 4.
                   Check exact value matches FIRST, then the +4 field, or a value
                   read of P+1 (a zero-state slot is 8 bytes) would be misread as a
                   +4 field read of P. */
                int pi = -1;
                int is_field = 0;
                for (uint16_t k = 0; k < sc; k++)
                    if (off == soff[k]) { pi = k; break; }
                if (pi < 0)
                    for (uint16_t k = 0; k < sc; k++)
                        if (off == soff[k] + 4u) { pi = k; is_field = 1; break; }
                if (pi < 0) continue;
                if (slot_core[pi] == score) continue;  /* intra-core: stays live */

                if (is_field) {
                    /* Cross-core +4 field read. Shadow the field directly so it is
                       not left racy. Overflow is a hard error: leaving the read
                       unshadowed would be an order-dependent race. */
                    if (rt->xcore_count >= LENS_MAX_SLOTS) return -7;
                    uint16_t idx = rt->xcore_count++;
                    rt->xcore_src[idx] = in;
                    lens_shadow_pool[idx] = *in;
                    *inp[j] = (void*)&lens_shadow_pool[idx];
                    continue;
                }

                /* Cross-core value read: one shadow per producer, reused. */
                if (shadow_idx[pi] < 0) {
                    if (rt->xcore_count >= LENS_MAX_SLOTS) return -7;
                    uint16_t idx = rt->xcore_count++;
                    rt->xcore_src[idx] = (int32_t*)(base + soff[pi]);
                    lens_shadow_pool[idx] = *rt->xcore_src[idx];
                    shadow_idx[pi] = (int16_t)idx;
                }
                *inp[j] = (void*)&lens_shadow_pool[shadow_idx[pi]];
            }
        }
    }

    /* --- BUFFER TABLE --- */

    /* Collect incoming audio buffer geometry to check against last apply. */
    uint32_t new_audio_lens[LENS_MAX_BUFFERS];
    uint8_t  new_audio_count = 0;
    {
        Cur scan = c;
        for (uint8_t i = 0; i < bc; i++) {
            if (!ok(&scan, 6)) { new_audio_count = 0; break; }
            uint8_t  kind  = u8(&scan);
            uint32_t blen  = u32(&scan);
            uint8_t  seed  = u8(&scan);
            if (kind == LENS_BUF_KIND_AUDIO && new_audio_count < LENS_MAX_BUFFERS)
                new_audio_lens[new_audio_count++] = blen;
            if (seed) {
                /* skip seed data: blen * 2 bytes */
                if (!ok(&scan, (size_t)blen * 2u)) { new_audio_count = 0; break; }
                scan.p += (size_t)blen * 2u;
            }
        }
    }

    /* Geometry match: same number of audio buffers with identical lengths. */
    int geom_same = (new_audio_count == g_last_audio_count) && (new_audio_count > 0);
    for (uint8_t i = 0; geom_same && i < new_audio_count; i++) {
        if (new_audio_lens[i] != g_last_audio_lens[i]) geom_same = 0;
    }

    rt->buffers = lens_buffer_pool;
    for (uint8_t i = 0; i < bc; i++) {
        if (!ok(&c, 6)) return -1;
        uint8_t kind = u8(&c);
        uint32_t blen = u32(&c);
        uint8_t  seed = u8(&c);
        /* Cap at the audio pool's cell capacity so one buffer can span the whole
           torus (~1.82 s); the bump allocator rejects anything that won't fit. */
        const uint32_t max_cells = (LENS_AUDIO_BUFFER_BYTES * 2u) / 3u;
        if (blen > max_cells) blen = max_cells;
        rt->buffers[i].length   = blen;
        /* Packed byte storage: (blen * 3 + 1) >> 1 bytes (round up). */
        size_t nbytes = ((size_t)blen * 3u + 1u) >> 1;
        uint8_t* bytes;
        if (kind == LENS_BUF_KIND_AUDIO) {
            bytes = alloc_audio(nbytes);
            /* Skip zero-fill if geometry is preserved; content rings through. */
            if (!bytes) return -6;
            if (!geom_same) memset(bytes, 0, nbytes);
        } else {
            bytes = alloc_control(nbytes);
            if (!bytes) return -6;
            memset(bytes, 0, nbytes);
        }
        rt->buffers[i].bytes = bytes;
        if (seed) {
            for (uint32_t j = 0; j < blen; j++) {
                if (!ok(&c, 2)) return -1;
                pack12_write(bytes, j, (int32_t)(uint16_t)u16(&c));
            }
        }
    }

    /* Update stored geometry after successful buffer allocation. */
    g_last_audio_count = new_audio_count;
    for (uint8_t i = 0; i < new_audio_count; i++)
        g_last_audio_lens[i] = new_audio_lens[i];

    /* Apply buffer fixups. */
    for (uint16_t i = 0; i < nbfix; i++) {
        uint16_t wi  = bfixes[i].wi;
        uint8_t  idx = bfixes[i].in_idx;
        uint16_t bid = bfixes[i].buf_id;
        if (wi >= sc || bid >= bc) continue;
        void** inp[5] = { &rt->slots[wi].in0, &rt->slots[wi].in1,
                          &rt->slots[wi].in2, &rt->slots[wi].in3,
                          &rt->slots[wi].in4 };
        if (idx < 5) *inp[idx] = (void*)&rt->buffers[bid];
    }

    /* A tape op whose Buffer* input was not wired to a real buffer (it is fed a
       value, e.g. a runtime-selected tape) points instead at the empty-buffer
       sentinel so the op no-ops rather than reading a reinterpreted int32. */
    {
        struct Buffer* blo = &rt->buffers[0];
        struct Buffer* bhi = &rt->buffers[bc];
        for (uint16_t wi = 0; wi < sc; wi++) {
            int bi = buffer_input_index(rt->slots[wi].kernel_id);
            if (bi < 0) continue;
            void** inp[5] = { &rt->slots[wi].in0, &rt->slots[wi].in1,
                              &rt->slots[wi].in2, &rt->slots[wi].in3,
                              &rt->slots[wi].in4 };
            struct Buffer* p = (struct Buffer*)*inp[bi];
            if (p < blo || p >= bhi) *inp[bi] = (void*)&g_empty_buffer;
        }
    }

    /* --- TERMINAL TABLE --- */
    rt->terminals = lens_terminal_pool;
    for (uint8_t i = 0; i < tc; i++) {
        if (!ok(&c, 4)) return -1;
        rt->terminals[i].jack_id       = u8(&c);
        rt->terminals[i].slot_walk_idx = u16(&c);
        rt->terminals[i].mode          = u8(&c);
    }

    *out_rt = rt;
    return 0;
}
