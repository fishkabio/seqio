# @fishka/seqio

Sequencing I/O — parsers and writers for bioinformatics file formats.

Currently supports:

- **ABIF** (`.ab1` / `.abi`) — chromatogram traces produced by ABI Sanger / fragment analysis instruments. Lossless round-trip, browser- and Node-compatible.

Planned: SCF, FASTA, FASTQ.

## Install

```sh
npm install @fishka/seqio
```

## Use

### Quick parse (typed view + metadata)

```ts
import { parseAbif } from '@fishka/seqio/abif';
// or: import { parseAbif } from '@fishka/seqio';

const result = parseAbif(uint8ArrayOrArrayBuffer, 'sample.ab1');

result.baseCalls?.sequence;       // "ACGT..."
result.baseCalls?.confidences;    // [40, 38, 41, ...]
result.baseCalls?.positions;      // [13, 25, 38, ...] sample-point peaks
result.chromatogram.basecalled.A; // raw int16 trace for the A channel
result.metadata.sampleName;       // SMPL tag
result.metadata.samplingRate;     // SPAC tag (falls back to PLOC-derived spacing)
```

### Low-level (entry-by-entry, round-trip)

```ts
import { readAbif, writeAbif, findEntry, upsertEntry } from '@fishka/seqio/abif';
import { setSequence, setConfidences, setPositions, setAveragePeakSpacing } from '@fishka/seqio/abif';

const file = readAbif(bytes);
setSequence(file, 'ACGT...');
setConfidences(file, [40, 38, 41, ...]);
setPositions(file, [13, 25, 38, ...]);
setAveragePeakSpacing(file, 12.5, 'my-basecaller');
const out = writeAbif(file);
```

## Features

- Browser- and Node-compatible (Uint8Array + DataView, no Node Buffer dependency).
- Lossless round-trip: every directory entry preserved as raw payload.
- MacBinary preamble support.
- BioPython-compatible declared-vs-computed dataSize clamp.
- PLOC read/written as unsigned int16 (preserves traces > 32k scans).
- SPAC accepts both float32 (spec) and long (legacy) element types.
- PCON/PLOC version fallback when PBAS2 ships without matching PCON2/PLOC2.
- `ensureRawDataChannels()` helper for older DATA1..8-only files.

## License

MIT
