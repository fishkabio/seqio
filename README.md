# @fishka/seqio

Sequencing I/O — parsers and writers for bioinformatics file formats.

Currently supports:

- **ABIF** (`.ab1` / `.abi`) — chromatogram traces produced by ABI Sanger / fragment analysis instruments. Meaning-lossless round-trip (every entry preserved), browser- and Node-compatible.
- **FASTA / FASTQ / .qual** — text writers (Phred+33), pure and format-agnostic.

Planned: SCF; FASTA/FASTQ reading.

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

result.baseCalls?.sequence; // "ACGT..." (preferred/called version, upper-cased)
result.baseCalls?.confidences; // [40, 38, 41, ...]
result.baseCalls?.positions; // [13, 25, 38, ...] sample-point peaks
result.baseCallVariants; // every PBAS version present: [{ version, role: 'called'|'edited', ... }]
result.chromatogram.data9To12.A; // A-channel int16 trace of the DATA9..12 block
result.chromatogram.data1To4.A; // A-channel int16 trace of the DATA1..4 block
result.metadata.sampleName; // SMPL tag
result.metadata.samplingRate; // SPAC tag (falls back to PLOC-derived spacing)
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

### Text export (FASTA / FASTQ / .qual)

```ts
import { formatFasta, formatFastq, formatQual, hasUsableQuality } from '@fishka/seqio';

const record = { id: 'sample.ab1', sequence, qualities };

formatFasta(record); // ">sample.ab1\nACGT...\n" (wrapped at 60)
formatFasta(record, { lineWidth: 0 }); // single sequence line

// Phred+33; scores clamped to [0, 93]. Only emit quality when it exists —
// missing/all-255 PCON should stay FASTA-only rather than invent perfect Q.
if (hasUsableQuality(qualities)) {
  formatFastq(record); // "@sample.ab1\nACGT...\n+\n..."
  formatQual(record); // ">sample.ab1\n40 38 41 ...\n"
}
```

## Features

- Browser- and Node-compatible (Uint8Array + DataView, no Node Buffer dependency).
- Meaning-lossless round-trip: every directory entry preserved as a raw payload, so
  `readAbif(writeAbif(f))` reproduces the same entries. The output is not byte-for-byte
  identical to the input (payloads are repacked, `dataSize` normalized, MacBinary/padding
  dropped); a byte-exact layout-preserving writer is a possible future opt-in.
- MacBinary preamble support.
- BioPython-compatible declared-vs-computed dataSize clamp.
- PLOC read/written as unsigned int16 (preserves traces > 32k scans).
- SPAC accepts both float32 (spec) and long (legacy) element types.
- PCON/PLOC version fallback when PBAS2 ships without matching PCON2/PLOC2.
- `ensureRawDataChannels()` helper for older DATA1..8-only files.

## License

MIT
