# Cage Node Test Suite

This suite validates the Cage WASM core outside the browser.

## Anti-spoofing strategy

- Fixture files are checked against pinned SHA-256 digests before tests run.
- Every WASM profile result is validated against an independent JS oracle implementation.
- Deterministic challenge vectors are generated at runtime, so static hardcoded outputs cannot pass.
- Concurrency is exercised via parallel profiling calls.

## Run

```bash
npm run test:cage
```
