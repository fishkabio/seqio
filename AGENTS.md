# AGENTS.md

`@fishka/seqio` is a TypeScript library that parses and writes bioinformatics
sequencing file formats. ABIF (`.ab1` / `.abi`) is implemented today; SCF,
FASTA, FASTQ are planned. The library is browser- and Node-compatible (uses
`Uint8Array` + `DataView`, no Node `Buffer` dependency) and ships dual ESM +
CJS builds with type declarations.

# Project structure

```
├── src/abif/           ABIF reader/writer + typed view + high-level parser
├── tests/              Jest unit tests + .ab1 fixtures
├── dist/               Build output (ESM + CJS), generated, gitignored
├── index.ts            Root re-export of src/
├── tsconfig.json       Shared base + tsconfig.{esm,cjs}.json for dual build
└── jest.config.js
```

Layered design:

- `src/abif/raw.ts` — low-level `readAbif` / `writeAbif`, lossless round-trip.
- `src/abif/view.ts` — typed getters: `getDataChannel`, `getSequence`, ...
- `src/abif/setters.ts` — mutation helpers for basecallers.
- `src/abif/parser.ts` — high-level `parseAbif()` wrapper with metadata + decoded entries.

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
