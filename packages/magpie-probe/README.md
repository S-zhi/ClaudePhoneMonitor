# Magpie monitor probe

This is a minimal OpenCode-shaped plugin used to verify Magpie plugin loading and isolated filesystem access. It is a synthetic probe, not a session monitor: it reads only `fixture.jsonl` under the host-provided `directory/monitor-plugin-probe` folder and accepts rows shaped as `{"probe":true,"sequence":1}` with contiguous increasing sequence numbers. It never reads agent/session data, opens a server, starts a child process, or registers providers, tools, auth, or models.

The plugin writes `state.json` atomically once per tick. `cursor` and heartbeat fields are committed together. One process holds a SQLite `BEGIN IMMEDIATE` reservation in `lock.db`; concurrent hosts become standbys and retry until the reservation is released. Restart resumes the saved cursor. To exercise fixture consumption, append synthetic rows to `fixture.jsonl` in the Magpie config directory.
