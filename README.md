# entry-sitegen

A from-scratch, speed-tuned reimplementation of makefun-site 1.0.0's `build(input)`: `solve.js` exports
`run(input)`, turning one site's `{ site, templates, files }` into the same output tree (`{ path: text }`,
byte for byte) as the reference generator — same front matter rules, template dialect, Markdown subset,
slug rules, tag and index pages, static copying and `build-report.txt`. `main.ts` is the driver: it reads
`$MAKEFUN_INPUT_DIR/cases.json` (default `/input`), answers each case with `run()`, and writes
`$MAKEFUN_OUTPUT_DIR/answers.json` (default `/output`) under `--no-incremental-marking`. Speed comes from
single-pass Markdown rendering, table-driven character dispatch, allocation-free counting, build-constant
template chunk caching and per-value include memoization.
