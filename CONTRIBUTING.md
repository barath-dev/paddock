# Contributing to Paddock

Thanks for wanting to help. Most of what Paddock does today started as someone's comment or
question, so you don't have to write code to make a difference.

## Ways to help

- **Tell us what slows you down.** When you run many Claude Code or Codex sessions, what
  do you lose track of? [Suggest a feature](https://github.com/barath-dev/paddock/issues/new?template=feature_request.yml)
  and describe the situation, not only the fix.
- **Try it and tell us what breaks.** **Report a problem** in Settings › General (or
  `paddock report`) fills in the version and system for you. Please leave out anything
  private: folder names, session names, prompts, emails.
- **Build with us.** Issues marked [good first issue](https://github.com/barath-dev/paddock/labels/good%20first%20issue)
  are small and self-contained. Ones marked [help wanted](https://github.com/barath-dev/paddock/labels/help%20wanted)
  are bigger and still open to ideas about how they should work. Say in the issue that you're
  taking one, so two people don't build the same thing.

## Building and running it

You need [Rust](https://rustup.rs). There is nothing else to install: the page is plain
HTML, CSS and JavaScript with no build step, and it's built into the program.

```sh
cargo build --release      # target/release/paddock
cargo test                 # unit tests, and end-to-end tests against a fake claude (and codex)
```

To work on it, run a copy beside your installed one, with its own settings folder and port,
serving the page from `ui/` so a reload picks up your changes:

```sh
export PADDOCK_UI_DIR=ui PADDOCK_HOME="$PWD/target/dev-home" PADDOCK_PORT=47901
cargo run --bin paddock            # starts it and opens the page
cargo run --bin paddock -- stop
```

The copy reads your real Claude Code and Codex folders, so **Close** in it closes real
sessions. Rust changes need a `cargo run` again; page changes only need a reload.

## Where things are

| Path | What it is |
|------|------------|
| `src/server.rs` | The local web server and its JSON API (`/api/...`) |
| `src/history.rs` | Reads Claude Code transcripts: prompts, titles, tokens by the hour |
| `src/codex.rs` | The same for Codex |
| `src/sessions.rs`, `src/closing.rs`, `src/resume.rs` | Open sessions: finding, closing, resuming |
| `src/accounts.rs` | Accounts: add, rename, log in, remove, restore |
| `src/loops.rs` | The loop check ("Worth a look") |
| `src/team.rs` | Teams of sub-agents |
| `src/cli.rs` | The `paddock` command line |
| `src/os/` | Everything that differs between macOS, Linux and Windows |
| `ui/app.js` | The Classic layout (`/`) |
| `ui/concept.js` | The Finder layout (`/finder`), including the Usage view |
| `ui/simple.js` | The Simple layout (`/simple`) |
| `ui/sky.js` | The 3D usage model, drawn on a canvas |
| `ui/settings.js` | The Settings window, shared by every layout |
| `tests/e2e.rs` | End-to-end tests; `tests/support/fake_claude.rs` stands in for `claude` |

## Before you open a pull request

- Run what CI runs: `cargo clippy --all-targets -- -D warnings` and `cargo test`. CI runs
  them on macOS, Linux and Windows.
- **Don't run `cargo fmt`** on the crate. The code isn't formatted with it, and it would
  rewrite every file. Format the lines you change to match the code around them.
- Write code that reads like the code around it: the same naming, and comments that say why
  in plain words.
- Ask in an issue before adding a dependency. The program has very few, and that's on purpose.
- Keep one change per pull request, and say in it how you checked it: the test you added, or
  what you did in the page.

## The rules Paddock keeps

These are promises to the people who use it (see "What it never does" in the
[README](README.md#what-it-never-does)), so a change can't break them:

- Never delete or move anything under an account folder (`~/.claude`, `~/.codex`, ...).
  The test suite checks this on every run.
- **Close** only stops a session; its transcript stays and it can be resumed.
- Names, pins and other Paddock records live in Paddock's own folder, never in a transcript.
- Nothing leaves the machine except the daily update check to GitHub. The page talks only
  to the local server, which listens on `127.0.0.1` and wants its token on every API call.

## Releases

The maintainer does releases: the version in `Cargo.toml`, a new entry at the top of
`ui/changes.json` for the What's new window, and the tag. You don't need to touch them in
a pull request.

## Licence

Paddock is MIT licensed. By opening a pull request you agree that your contribution is
released under the same [licence](LICENSE).
