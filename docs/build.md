# 🏭 Local Build

The GitHub nightly workflows build OpenAsar with `scripts/pack.js`, which:

- copies `src/` into a temporary build tree
- resolves and stamps the update repository and matching rolling release channel
- stamps the requested version and other build options into that copy
- strips and packs the copied tree with `asar`

Local builds use the same script without modifying the working tree in place.

## ✅ Requirements
- `node`
- `asar`

Example install for `asar`:

```bash
npm i -g asar
```

## 🔄 Build With Normal Auto-Update Behavior

This keeps the default OpenAsar self-update behavior enabled.

```bash
node scripts/pack.js --version nightly-$(git rev-parse --short HEAD) --output tmp/app.asar
```

The packer resolves the update repository in this order:

1. explicit `--update-repo owner/repo`
2. `OPENASAR_UPDATE_REPO`
3. `GITHUB_REPOSITORY` when `GITHUB_ACTIONS=true`
4. a valid GitHub `origin` remote in the local checkout
5. the `GooseMod/OpenAsar` fallback

HTTP(S), legacy Git, SSH URL, SSH-over-port-443, and scp-style GitHub origins are supported. The packer prints the selected repository, resolution source, and release channel. A `GooseMod/OpenAsar` build uses the upstream `nightly` release; every other repository uses its stable rolling `nightly-fork` release.

A normal clone or fork therefore needs no repository argument. Source archives, non-GitHub checkouts, and checkouts without a usable `origin` safely fall back to `GooseMod/OpenAsar`.

## 📦 Build With A Custom Update Repo

Use this when you want a build to self-update from your own fork releases instead of upstream.

```bash
node scripts/pack.js --update-repo owner/repo --version nightly-$(git rev-parse --short HEAD) --output tmp/app.asar
```

The equivalent environment override is:

```bash
OPENASAR_UPDATE_REPO=owner/repo node scripts/pack.js --version nightly-$(git rev-parse --short HEAD) --output tmp/app.asar
```

The command-line option takes precedence over the environment and automatic sources. Invalid explicit command-line values fail the build; invalid environment or remote candidates fall through to the next source.

## 🚫 Build With Auto-Update Disabled

Use this for local testing when you do not want the built `app.asar` to replace itself from the resolved release repository on launch.

```bash
node scripts/pack.js --disable-autoupdate --version nightly-$(git rev-parse --short HEAD)-localtest --output tmp/app.asar
```

The local wrapper accepts the same optional build arguments. It still resolves and stamps the repository identity, but the stamped self-update route remains inactive because the wrapper always supplies `--disable-autoupdate`:

```bash
./local-build-no-autoupdate.zsh
./local-build-no-autoupdate.zsh --update-repo owner/repo
./local-build-no-autoupdate.zsh --help
```

## 🍎 Optional macOS Recovery Timeout

The macOS post-update helper uses a 90-second recovery window by default. Override that build-time value with a positive integer when a different timeout is needed:

```bash
node scripts/pack.js --macos-recovery-timeout-seconds 60 --version nightly-$(git rev-parse --short HEAD) --output tmp/app.asar
```

The equivalent environment variable is:

```bash
OPENASAR_MACOS_RECOVERY_TIMEOUT_SECONDS=60 node scripts/pack.js --version nightly-$(git rev-parse --short HEAD) --output tmp/app.asar
```

An explicit command-line value takes precedence over the environment variable. The local no-auto-update wrapper also forwards this option:

```bash
./local-build-no-autoupdate.zsh --macos-recovery-timeout-seconds 60
./local-build-no-autoupdate.zsh -mrts 60
```

`-mrts` is a local-wrapper alias for the long timeout option. Both forms can
be passed first because this wrapper forwards its options directly to the
packer.

This changes only the three long macOS recovery paths. The standalone legacy wait uses the configured window exactly, while the standalone guard keeps its existing 30-second wait. When BetterDiscord is detected, OpenAsar adds a 10-second coordination grace so matching recovery windows do not race. Keep OpenAsar's configured window at least as long as BetterDiscord's; the normal 90-second defaults therefore coordinate for up to 100 seconds. Other updater timers are unchanged.

## 📤 Output

All commands above produce:

```text
tmp/app.asar
```

## 🧪 Testing

Run the focused VersionLock, updater-mode, manifest-cache, and logging tests with:

```bash
node --test tests/index-updater-mode.test.js tests/version-lock-*.test.js
```

Run the fork repository, pack-stamping, and updater-routing tests with:

```bash
node --test tests/update-repo-resolution.test.js tests/pack-update-repo.test.js tests/asar-update-routing.test.js
```

Run the full repository test suite with:

```bash
node --test tests/*.test.js
```

The automated platform fixtures cover macOS, Windows, and Linux mappings without touching live Discord installations. Only macOS has received live VersionLock testing; Windows and Linux behavior remains untested outside the fixtures.

## ⚙️ Optional GitHub Workflows

This fork keeps three workflow variants:

- `.github/workflows/nightly.yml`
- `.github/workflows/nightly-disable-autoupdate.yml`
- `.github/workflows/nightly-custom-update-repo.yml`

Manual workflow runs expose an optional macOS recovery timeout input whose workflow-build default is `55` seconds. Builds made without an explicit workflow or local override keep the normal `90`-second source default.

All three workflows:

- build an `app.asar`
- run the same Linux and Windows startup smoke tests
- publish a release in the repo where the workflow runs
- grant read-only repository access by default and write access only to their release jobs

The smoke jobs are currently independent validation rather than release gates: each release job depends only on `build`, while its test dependencies remain commented out.

After Actions is enabled on a fork, no repository-name edit is required. The intended differences are:

- `nightly.yml`: manual normal build explicitly following the upstream `GooseMod/OpenAsar` `nightly` release
- `nightly-disable-autoupdate.yml`: packs with `--disable-autoupdate`
- `nightly-disable-autoupdate.yml`: publishes `nightly-no-autoupdate`
- `nightly-custom-update-repo.yml`: runs manually or on `develop` pushes that affect source, scripts, or workflows
- `nightly-custom-update-repo.yml`: derives the current fork from GitHub Actions' `GITHUB_REPOSITORY`
- `nightly-custom-update-repo.yml`: publishes `nightly-fork`
