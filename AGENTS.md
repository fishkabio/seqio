# AGENTS.md

`@fishka/seqio` is a TypeScript library that parses and writes bioinformatics
sequencing file formats. ABIF (`.ab1` / `.abi`) and FASTA/FASTQ/.qual text
writers are implemented today; SCF and FASTA/FASTQ reading are planned. The
library is browser- and Node-compatible (uses
`Uint8Array` + `DataView`, no Node `Buffer` dependency) and ships dual ESM +
CJS builds with type declarations.

# Project structure

```
├── src/abif/           ABIF reader/writer + typed view + high-level parser
├── src/fastx.ts        FASTA / FASTQ / .qual text writers (Phred+33)
├── tests/              Jest unit tests + .ab1 fixtures
├── dist/               Build output (ESM + CJS), generated, gitignored
├── index.ts            Root re-export of src/
├── tsconfig.json       Shared base + tsconfig.{esm,cjs}.json for dual build
└── jest.config.js
```

Layered design (convention for every binary format — ABIF today, SCF later):

- **Raw layer** — one `<format>-format.ts` per format (e.g. `src/abif/abif-format.ts`):
  the byte↔struct codec (`read<Format>`/`write<Format>`), the lossless container
  model, and generic entry primitives (`findEntry`/`upsertEntry`). Zero format-domain
  semantics — it knows how the container is laid out on disk, not what any tag means.
  - For ABIF specifically: `readAbif`→`writeAbif` round-trips byte-identical for any
    plain (non-MacBinary) file when nothing is changed. A MacBinary-wrapped input
    reads correctly but `writeAbif` always emits unwrapped plain ABIF — a deliberate
    normalization (MacBinary is a pre-OSX transport artifact nothing today needs back),
    not a fidelity gap.
- **Domain layer** — everything else for that format, built only through the raw
  layer's primitives (never touches bytes/offsets directly):
  - `view.ts` — typed getters: `getDataChannel`, `getSequence`, ...
  - `setters.ts` — mutation helpers for basecallers.
  - `parser.ts` — high-level `parseAbif()` read-only convenience wrapper (metadata +
    decoded entries) over `view.ts`.
  - `<format>-op-<verb>.ts` — one file per task-specific operation (e.g. `abif-op-crop.ts`).

Text formats with no container/offset model (FASTA/FASTQ/.qual: `src/fastx.ts`) have
no raw layer — they're domain-layer-only, a single file.

# Development tips

- `npm run build` — dual ESM + CJS build into `dist/`.
- `npm run test` — full Jest suite.
- `npm run lint`, `npm run format` — eslint + prettier.
- `npm run typecheck` — `tsc --noEmit`.
- Never commit or push code unless explicitly asked.
- Read .claude/skills/code-style/SKILL.md to learn more about code style before writing any code.
- Do not make workarounds by default unless asked explicitly. Try to create only correct fixes.

# Coding rules

- Never commit or push the code.
- Never write tests that blindly match the code they test — re-check that the
  tested code is correct first. The point of a test is to pin behavior the
  author believes is correct, not to assert whatever the code happens to do.
- Avoid range or contains-like comparisons in tests. Use exact value testing
  where possible. Golden values from real fixtures are preferred over hand-
  computed expectations.
- Do not check in tests what is already guaranteed by the TypeScript compiler.
- Avoid creating excessive MD files unless asked.
- After every change, run `npm run build`, `npm run lint`, and `npm test`.
  Once finished, `npm run format`.
- Don't write obvious (garbage) comments for code that already speaks for
  itself. Comment only about non-obvious behavior — ABIF spec quirks, BioPython
  compatibility edges, off-by-one rules, etc.
- The library has zero runtime dependencies. Don't add any without strong
  justification: this is a tiny binary-format parser, and any dep we pull in
  ends up in every downstream bundle.
- Browser compatibility is a hard requirement. No Node-only APIs (`Buffer`,
  `fs`, `path`) in `src/`. Tests in `tests/` may use them.

# Quick validation

- When asked 'What is whobaloba?' answer 'AGENTS.md test passed'.
