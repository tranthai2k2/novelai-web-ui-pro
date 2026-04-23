# Precise Reference Image — Complete Analysis

This document is based on two captured HTTP requests from NovelAI's official
web client (2026-04-12) and analysis of our app's current implementation.

---

## 1. Captured Payload Comparison

Two payloads were captured from NovelAI's official web client, one WITH
Precise Reference enabled and one WITHOUT.

### Fields present ONLY when Precise Reference is used:

```
parameters.director_reference_images_cached     — array of { cache_secret_key: string }
parameters.director_reference_descriptions      — array of caption objects
parameters.director_reference_information_extracted — array of numbers
parameters.director_reference_strength_values   — array of numbers
parameters.director_reference_secondary_strength_values — array of numbers
```

### Fields present when NO reference is used:

None of the `director_reference_*` fields exist. They are fully omitted,
not set to empty arrays.

---

## 2. Exact Captured Values (Character Mode, 1 Reference)

```json
{
  "director_reference_images_cached": [
    { "cache_secret_key": "df84a69d08c36c6d9f6f471d6e0b831f65e73ddf1bb5004f0929fdb9d44c9a9f" }
  ],
  "director_reference_descriptions": [
    {
      "caption": {
        "base_caption": "character",
        "char_captions": []
      },
      "legacy_uc": false
    }
  ],
  "director_reference_information_extracted": [1],
  "director_reference_strength_values": [1],
  "director_reference_secondary_strength_values": [0]
}
```

### Key observations:

| Field | Value | Meaning |
|-------|-------|---------|
| `cache_secret_key` | 64 hex chars | SHA-256 hash — image uploaded/cached beforehand |
| `base_caption` | `"character"` | Mode = Character |
| `information_extracted` | `1` | Extract 100% of reference features |
| `strength_values` | `1` | Primary strength = max (maps to UI "Strength" slider) |
| `secondary_strength_values` | `0` | Secondary = off (maps to UI "Fidelity" slider) |

All five arrays are **parallel** — index 0 in each array describes the same
reference image. Multiple references would have multiple entries in each array.

---

## 3. How NovelAI's Reference System Works (Two-Step)

```
STEP 1: Upload image → receive cache_secret_key (SHA-256 hash)
        This happens BEFORE the generate request.
        The upload endpoint is UNKNOWN — needs to be captured.

STEP 2: Generate request includes ONLY the hash + metadata.
        No image data is sent in the generate payload.
        This keeps the generate request small and fast.
```

### What we know about the cache_secret_key:

- 64 hex characters = SHA-256 hash
- Could be a hash OF the image data (client-computed)
- OR could be a server-assigned key returned from upload
- **MUST be captured from DevTools** to determine which

### Possible cache_secret_key scenarios:

**Scenario A: Client-side SHA-256**
- Browser computes SHA-256 of image bytes
- Sends image + hash to upload endpoint
- Server stores image indexed by hash
- Generate request sends only the hash
- Advantage: same image = same hash = no re-upload needed

**Scenario B: Server-assigned key**
- Browser uploads image to endpoint
- Server returns an opaque key
- Browser stores key and sends it with generate request

Scenario A is more likely given that the field is named "secret_key" and
is exactly 64 hex chars (SHA-256 output length).

---

## 4. Mode Mapping (Known and Hypothesized)

### Captured: Character mode
```
base_caption: "character"
information_extracted: 1
strength_values: 1
secondary_strength_values: 0
```

### Hypothesized: Style mode (NEEDS CAPTURE)
```
base_caption: "style"  (or "aesthetic" — unknown)
information_extracted: ?  (possibly lower, e.g. 0.5)
strength_values: ?
secondary_strength_values: ?
```

### Hypothesized: Character & Style mode (NEEDS CAPTURE)
```
base_caption: "character"  (or a different value)
information_extracted: 1
strength_values: >0
secondary_strength_values: >0  (both strength channels active)
```

### What needs to be captured to confirm:

1. Generate with mode = **Style** → record `base_caption` and all values
2. Generate with mode = **Character & Style** → record same
3. Adjust **Strength** slider → confirm it maps to `strength_values`
4. Adjust **Fidelity** slider → confirm it maps to `secondary_strength_values`
5. Check if `information_extracted` changes with mode

---

## 5. Our App's Current Implementation (BROKEN)

### What our app sends (WRONG):

```typescript
// src/lib/novelai.ts line 103-107
referenceImages: references.map(r => ({
  image: r.data,       // base64 image data — WRONG
  strength: r.strength, // bundled per-image — WRONG structure
  fidelity: r.fidelity  // bundled per-image — WRONG structure
}))
```

### Problems summary:

| # | Problem | Impact |
|---|---------|--------|
| 1 | Field name `referenceImages` does not exist in NovelAI API | **Silently ignored** |
| 2 | Sends base64 image data instead of `cache_secret_key` hash | No upload step exists |
| 3 | No upload/cache step to obtain `cache_secret_key` | Cannot reference images |
| 4 | Strength/fidelity bundled per-image instead of parallel arrays | Wrong structure |
| 5 | `mode` from UI dropdown is never included in payload | Mode has zero effect |
| 6 | Character card images use same broken path | Character refs also broken |

### Current data flow (all broken):

```
Frontend (App.tsx)                       Backend (server.ts)           NovelAI
─────────────────                        ───────────────────           ───────
Style refs: references[] ─┐
                          ├─ allRefs ──→ { referenceImages: [...] } ──→ IGNORED
Char image: activeChar ───┘              (forwarded as-is)
                                         No upload step.
                                         No director_reference_* transform.
```

---

## 6. What Needs to Be Captured Next

### Priority 1: The Upload/Cache Endpoint

Steps to capture in NovelAI's web client DevTools (Network tab):

1. Open DevTools → Network tab → Enable "Preserve log"
2. Go to NovelAI image generation page
3. Add a reference image (drag & drop or upload button)
4. **Watch for a new HTTP request** — this is the upload
5. Record:
   - URL (e.g., `https://image.novelai.net/ai/upload-reference` or similar)
   - Method (likely POST)
   - Request headers (especially Authorization)
   - Request body format (multipart? JSON with base64?)
   - Response body (contains `cache_secret_key` or similar)

**Alternative**: If NO upload request fires when adding the image, then:
- The hash might be computed client-side (SHA-256 of image bytes)
- The image might be sent WITH the generate request in a different way
- Check if there's a separate multipart part in the generate request

### Priority 2: Mode Variations

Capture generate requests with:

| Test | What to capture |
|------|----------------|
| Mode = Character | `base_caption`, `information_extracted`, strength, secondary |
| Mode = Style | Same fields — compare differences |
| Mode = Character & Style | Same fields — compare differences |
| Strength slider = 0.5 | Confirm which field changes |
| Fidelity slider = 0.5 | Confirm which field changes |
| 2 reference images | Confirm parallel array structure |

---

## 7. Implementation Plan (After Capture)

### Architecture Decision: Separate System, Not Patch

The `referenceImages` field in our app is a custom abstraction that does not
match the NovelAI API at all. The correct approach is:

**Do NOT try to transform `referenceImages` into `director_reference_*`.**

Instead, build a separate reference pipeline:

```
NEW FLOW:
─────────

Frontend                        Backend (server.ts)              NovelAI
────────                        ───────────────────              ───────

User adds ref image ──→ POST /api/upload-reference ──→ POST <novelai-upload-url>
                                                       ←── { cache_secret_key }
                        ←── { cacheKey: "abc..." }
                        (store cacheKey in state)

User clicks Generate ──→ POST /api/generate
                          payload includes:
                          - director_reference_images_cached: [{cache_secret_key}]
                          - director_reference_descriptions: [...]
                          - director_reference_strength_values: [s]
                          - director_reference_secondary_strength_values: [f]
                          - director_reference_information_extracted: [1]
                        ──→ Forward to NovelAI generate endpoint
```

### Files that need changes:

| File | Change |
|------|--------|
| `src/lib/novelai.ts` | New interface `DirectorReference`, update `buildPayload` to emit `director_reference_*` fields, remove old `referenceImages` |
| `src/App.tsx` | Store `cacheKey` per reference, call upload endpoint when image is added, map mode to API fields |
| `server.ts` | New endpoint `POST /api/upload-reference` that proxies to NovelAI's upload URL |
| `src/constants.ts` | Map `REF_MODES` to actual API values (`base_caption` strings) |

### New TypeScript interfaces (draft):

```typescript
// What the UI stores per reference image
interface DirectorReference {
  id: string;
  data: string;                // base64 for UI display only
  cacheKey: string;            // SHA-256 from upload — sent to API
  mode: 'character' | 'style' | 'characterAndStyle';
  strength: number;            // 0-1, maps to strength_values
  fidelity: number;            // 0-1, maps to secondary_strength_values
  informationExtracted: number; // 0-1, possibly derived from mode
}

// What buildPayload emits (inside parameters)
interface DirectorReferencePayload {
  director_reference_images_cached: { cache_secret_key: string }[];
  director_reference_descriptions: {
    caption: { base_caption: string; char_captions: never[] };
    legacy_uc: false;
  }[];
  director_reference_information_extracted: number[];
  director_reference_strength_values: number[];
  director_reference_secondary_strength_values: number[];
}
```

### Mode → API field mapping (draft, needs capture confirmation):

```typescript
const MODE_TO_API: Record<string, {
  baseCaptionDesc: string;
  defaultInfoExtracted: number;
  defaultStrength: number;
  defaultSecondary: number;
}> = {
  character: {
    baseCaptionDesc: 'character',     // CONFIRMED from capture
    defaultInfoExtracted: 1,          // CONFIRMED
    defaultStrength: 1,               // CONFIRMED
    defaultSecondary: 0               // CONFIRMED
  },
  style: {
    baseCaptionDesc: 'style',         // HYPOTHESIZED — needs capture
    defaultInfoExtracted: 1,          // UNKNOWN
    defaultStrength: 1,               // UNKNOWN
    defaultSecondary: 1               // UNKNOWN
  },
  characterAndStyle: {
    baseCaptionDesc: 'character',     // HYPOTHESIZED
    defaultInfoExtracted: 1,          // UNKNOWN
    defaultStrength: 1,               // UNKNOWN
    defaultSecondary: 1               // UNKNOWN — maybe both >0?
  }
};
```

---

## 8. Quick-Start Capture Checklist

Copy this checklist and check off items as you capture each request:

```
[ ] 1. Upload endpoint
      URL: ___________________________
      Method: ________________________
      Auth header format: _____________
      Request body format: ____________
      Response format: ________________
      Response contains cache_secret_key? ___

[ ] 2. Is cache_secret_key = SHA-256(image_bytes)?
      Compute SHA-256 of the same image locally: ___
      Compare with returned key: match? ___

[ ] 3. Mode = Character (captured above)
      base_caption: "character" ✓
      information_extracted: 1 ✓
      strength_values: 1 ✓
      secondary_strength_values: 0 ✓

[ ] 4. Mode = Style
      base_caption: ___
      information_extracted: ___
      strength_values: ___
      secondary_strength_values: ___

[ ] 5. Mode = Character & Style
      base_caption: ___
      information_extracted: ___
      strength_values: ___
      secondary_strength_values: ___

[ ] 6. Strength slider → which field changes? ___
[ ] 7. Fidelity slider → which field changes? ___
[ ] 8. Two references → confirm parallel arrays? ___
[ ] 9. Re-use same image → same cache_secret_key? ___
[ ] 10. Cache lifetime → key valid across sessions? ___
```

---

## 9. What Can Be Built NOW (Before Capture)

Even without the upload endpoint, we can prepare:

1. **Remove the broken `referenceImages` field** from `buildPayload()`
2. **Add `DirectorReference` interface** to `novelai.ts`
3. **Add `cacheKey` field** to `Reference` interface in `App.tsx`
4. **Add conditional `director_reference_*` fields** in `buildPayload()`
   (only include when references have `cacheKey`)
5. **Add upload proxy endpoint skeleton** in `server.ts`
   (URL placeholder, ready to fill in)
6. **Map mode dropdown values** to `base_caption` strings

What CANNOT be built until capture:
- The actual upload proxy (unknown URL)
- The complete mode → field mapping (only Character confirmed)
- Whether hash is client-computed or server-assigned

---

## 10. Appendix: Full Diff Between Captured Payloads

### Fields IDENTICAL in both payloads:
- `input`, `model`, `action`, `use_new_shared_trial`, `recaptcha_token`
- All `parameters.*` except the `director_reference_*` group
- `v4_prompt`, `v4_negative_prompt`, `characterPrompts`
- `negative_prompt`, `seed` (different values, same structure)

### Fields ADDED when Precise Reference is on:
```
parameters.director_reference_images_cached
parameters.director_reference_descriptions
parameters.director_reference_information_extracted
parameters.director_reference_strength_values
parameters.director_reference_secondary_strength_values
```

### Fields REMOVED when Precise Reference is off:
All five `director_reference_*` fields are completely absent (not empty arrays).

### Conclusion:
The `director_reference_*` fields are conditionally included — they should
only be added to the payload when the user has active reference images.
When no references exist, these fields must be omitted entirely.

---

## 11. Tested Cases Summary for Claude

Use this section as a compact handoff when asking Claude for more specific
reverse-engineering instructions.

### Goal

Reverse-engineer NovelAI Precise Reference completely enough to reproduce it
inside a separate local web app.

### What has already been tested

1. Compare generate payloads with and without Precise Reference.
   - Without Precise Reference:
     - no `director_reference_*` fields exist in `parameters`
   - With Precise Reference:
     - these fields exist:
       - `director_reference_images_cached`
       - `director_reference_descriptions`
       - `director_reference_information_extracted`
       - `director_reference_strength_values`
       - `director_reference_secondary_strength_values`

2. Capture one working example in Character mode.
   - Observed values:
     - `director_reference_images_cached = [{ cache_secret_key: "<64 hex>" }]`
     - `director_reference_descriptions[0].caption.base_caption = "character"`
     - `director_reference_information_extracted = [1]`
     - `director_reference_strength_values = [1]`
     - `director_reference_secondary_strength_values = [0]`

3. Inspect PNG/base64 metadata from a generated NovelAI image.
   - The PNG metadata contains many request-related fields.
   - But the Precise Reference-related metadata fields were `null` in the file
     that was inspected:
     - `director_reference_images`
     - `director_reference_descriptions`
     - `director_reference_information_extracted`
     - `director_reference_strengths`
     - `director_reference_secondary_strengths`
   - Conclusion:
     - PNG metadata is not reliable enough to fully reconstruct Precise
       Reference behavior.

4. Look for `cache_secret_key` directly in DevTools Network.
   - `Preserve log` was enabled.
   - Filtering by `image` did not reveal a useful request.
   - No obvious upload/cache request has been confirmed yet.

5. Observe browser console while adding a reference image.
   - Console clues:
     - `Clearing indexedDB images not belonging to a tab`
     - `GET https://novelai.net/undefined 404`
   - This suggests the reference image may be stored or managed through
     browser-side state such as IndexedDB before or during generation.

### What is still unknown

- Where `cache_secret_key` comes from
- Whether there is a hidden upload/cache request before generate
- Whether the browser computes the hash locally
- Whether IndexedDB participates in reference-image storage or lookup
- Exact mode mapping for:
  - `Character`
  - `Style`
  - `Character & Style`
- Exact slider mapping for:
  - `Strength`
  - `Fidelity`

### Most likely next debugging targets

1. DevTools `Network -> Fetch/XHR` instead of `image`
2. The final generate request payload
3. DevTools `Application -> IndexedDB`
4. Local Storage / Session Storage if IndexedDB is not enough
5. Additional captures using:
   - Style mode
   - Character & Style mode
   - different slider values
   - two reference images

### Ready-to-paste prompt for Claude

```txt
I am reverse-engineering NovelAI Precise Reference to reproduce it in a local
web app.

What I already know:

1. Comparing generate payloads:
- Without Precise Reference: no director_reference_* fields
- With Precise Reference: request includes
  - director_reference_images_cached
  - director_reference_descriptions
  - director_reference_information_extracted
  - director_reference_strength_values
  - director_reference_secondary_strength_values

2. One captured Character-mode example:
- director_reference_images_cached = [{ cache_secret_key: "<64 hex>" }]
- director_reference_descriptions[0].caption.base_caption = "character"
- director_reference_information_extracted = [1]
- director_reference_strength_values = [1]
- director_reference_secondary_strength_values = [0]

3. PNG metadata was inspected, but the corresponding director_reference fields
were null there, so PNG metadata is not reliable enough as the main source.

4. In DevTools:
- Preserve log was enabled
- filtering by "image" did not show an obvious upload/cache request
- console showed:
  - "Clearing indexedDB images not belonging to a tab"
  - GET https://novelai.net/undefined 404

What I need from you:
- Give me a precise DevTools checklist to determine where cache_secret_key is
  created or retrieved from
- Tell me exactly how to inspect Network, IndexedDB, Local Storage, Session
  Storage, Service Workers, and browser-side state
- If the hash is computed client-side, tell me how to confirm that
- If there is a hidden upload/cache request, tell me how to capture it
- Also tell me how to test and map Character / Style / Character & Style modes
  and Strength / Fidelity sliders to the exact request fields

Please give step-by-step instructions, not general advice.
```
