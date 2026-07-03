# @fishka/seqio

Part of [fishka.bio](https://fishka.bio) — free browser-based bioinformatics tools.

Browser- and Node-compatible sequencing file I/O.

Current API:

- **ABIF** (`.ab1` / `.abi`) parser, typed chromatogram view, raw reader/writer,
  and mutation helpers.
- **FASTA / FASTQ / .qual** text writers with Phred+33 quality encoding.

Planned: SCF and FASTA/FASTQ readers.

## Install

```sh
npm install @fishka/seqio
```

## ABIF

Use `parseAbif()` when you want a ready-to-render chromatogram, base calls, and
metadata from an `.ab1` file.

```ts
import { parseAbif } from '@fishka/seqio/abif';

const result = parseAbif(uint8ArrayOrArrayBuffer, 'sample.ab1');

result.baseCalls?.sequence; // preferred called sequence, upper-cased
result.baseCalls?.confidences; // PCON quality scores
result.baseCalls?.positions; // PLOC peak positions
result.baseCallVariants; // all PBAS/PCON/PLOC versions found
result.chromatogram.data9To12.A; // A trace mapped through FWO_
result.metadata.sampleName;
```

Use `readAbif()` / `writeAbif()` when you need entry-level access or want to
preserve unknown vendor tags during a round trip.

```ts
import { readAbif, writeAbif, findEntry, upsertEntry } from '@fishka/seqio/abif';
import { setAveragePeakSpacing, setConfidences, setPositions, setSequence } from '@fishka/seqio/abif';

const file = readAbif(bytes);

findEntry(file, 'SMPL', 1);
const commentPayload = new TextEncoder().encode('basecalled');
upsertEntry(file, 'CMNT', 1, commentPayload, {
  elementType: 2,
  elementSize: 1,
  elementCount: commentPayload.byteLength,
});

setSequence(file, 'ACGT...');
setConfidences(file, [40, 38, 41]);
setPositions(file, [13, 25, 38]);
setAveragePeakSpacing(file, 12.5, 'my-basecaller');

const out = writeAbif(file);
```

## FASTA / FASTQ / .qual

```ts
import { formatFasta, formatFastq, formatQual, hasUsableQuality } from '@fishka/seqio';

const record = { id: 'sample.ab1', sequence, qualities };

formatFasta(record); // wrapped at 60 residues by default
formatFasta(record, { lineWidth: 0 }); // single sequence line

if (hasUsableQuality(qualities)) {
  formatFastq(record); // Phred+33, scores clamped to [0, 93]
  formatQual(record);
}
```

## API

- `parseAbif(input, fileName?)`
- `readAbif(bytes)`, `writeAbif(file)`, `findEntry()`, `findEntries()`,
  `upsertEntry()`
- `getSequence()`, `getConfidences()`, `getPositions()`, `getDataChannel()`,
  `getChannelMap()`, `getSamplingRate()`
- `setSequence()`, `setConfidences()`, `setPositions()`,
  `setAveragePeakSpacing()`, `ensureRawDataChannels()`
- `formatFasta()`, `formatFastq()`, `formatQual()`, `hasUsableQuality()`

The library uses `Uint8Array` and `DataView`, with no Node `Buffer` dependency.
ABIF writing is meaning-lossless rather than byte-for-byte layout preserving:
unknown entries are kept, but payloads may be repacked and padding normalized.

## License

MIT
