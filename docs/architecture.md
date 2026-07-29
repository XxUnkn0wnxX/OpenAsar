# 🏗️ Developer Architecture

This document maps the custom systems maintained by this OpenAsar fork on top of upstream OpenAsar.

Use the file names, functions, settings, and state files below as stable search anchors. This describes the current source tree, not every historical implementation mentioned in the changelog.

## 🧭 Responsibility Map

| Area | Primary owner | Responsibility |
|---|---|---|
| Process entry and archive ownership | [`src/index.js`](../src/index.js), [`src/injection.js`](../src/injection.js) | Resolve the real OpenAsar archive, validate BetterDiscord's nested wrapper, fill settings defaults, synchronize updater mode, and enter bootstrap. |
| Startup policy | [`src/bootstrap.js`](../src/bootstrap.js) | Validate `VersionLock`, initialize launch logging, configure the chosen updater, and prevent Discord startup when a lock cannot be honored. |
| Settings persistence | [`src/appSettings.js`](../src/appSettings.js), [`src/config/index.js`](../src/config/index.js) | Preserve external edits, enforce the legacy-updater override, and retain backend-only settings when the hosted config panel saves. |
| Legacy updater | [`src/updater/moduleUpdater.js`](../src/updater/moduleUpdater.js) | Keep Discord's legacy host/module update chain while allowing a lock to suppress only the host check. |
| Native updater | [`src/updater/updater.js`](../src/updater/updater.js), [`src/splash/index.js`](../src/splash/index.js) | Wrap `updater.node`, apply native manifests, commit module paths, activate an unlocked host, and retain OpenAsar across host replacement. |
| Version lock | [`src/utils/versionLock.js`](../src/utils/versionLock.js), [`src/utils/nativeVersionLock.js`](../src/utils/nativeVersionLock.js) | Parse the shared setting, enforce binary equality, and set or clear Discord's native `Pinned` manifest. |
| Manifest recovery | [`src/utils/pinnedUpdateManifest.js`](../src/utils/pinnedUpdateManifest.js), [`src/utils/updaterIdentity.js`](../src/utils/updaterIdentity.js) | Validate, fetch, reconstruct, hash, cache, and identify an exact native updater manifest. |
| Launch diagnostics | [`src/utils/versionLockLogger.js`](../src/utils/versionLockLogger.js) | Recreate a per-launch JSON Lines log for both updater modes. |
| macOS host recovery | [`src/updater/updater.js`](../src/updater/updater.js), [`src/updater/moduleUpdater.js`](../src/updater/moduleUpdater.js) | Coordinate ShipIt, legacy host replacement, OpenAsar restoration, and BetterDiscord wrapper-regeneration handoffs. |
| Settings UI compatibility | [`src/mainWindow.js`](../src/mainWindow.js) | Inject independent OpenAsar version and settings entries into changing Discord/BetterDiscord sidebar layouts. |
| OpenAsar self-update | [`src/asarUpdate.js`](../src/asarUpdate.js) | Update the exact ASAR that currently owns OpenAsar, independently of Discord's host updater. |
| Packaging and release | [`scripts/pack.js`](../scripts/pack.js), [`local-build-no-autoupdate.zsh`](../local-build-no-autoupdate.zsh), [`.github/workflows`](../.github/workflows) | Stamp fork options into a temporary source copy, pack it, smoke-test it, and publish the intended release variant. |

## 🚦 Startup Order and Policy Gates

The main-process order is intentional:

```text
resolve running ASAR and host Resources directory
  -> validate BetterDiscord wrapper ownership
  -> initialize channel paths and settings
  -> fill missing OpenAsar defaults
  -> synchronize USE_NEW_UPDATER from forceLegacyUpdater
  -> refresh/arm the passive macOS recovery guard when applicable
  -> load Constants with the synchronized updater mode
  -> wait for Electron app readiness
  -> initialize VersionLock launch logging
  -> validate VersionLock against the running Discord binary
  -> set/clear native Pinned state, or initialize the legacy updater
  -> start first-run/splash update work
  -> load discord_desktop_core
```

- [`src/index.js`](../src/index.js) runs updater-mode synchronization before [`src/Constants.js`](../src/Constants.js) reads `USE_NEW_UPDATER`.
- [`startUpdate`](../src/bootstrap.js) initializes the launch logger and validates `VersionLock` before native updater initialization, legacy module initialization, first-run work, splash update work, or `discord_desktop_core`.
- A passive macOS recovery guard can be prepared earlier in `src/index.js`. It refreshes existing recovery assets and responds only to a real pending handoff; it is not a Discord update check and does not weaken the VersionLock gate.
- A locked native launch fails closed if `updater.node` cannot initialize. An unlocked launch retains OpenAsar's normal ability to fall back to the legacy updater.
- The overlay-host entry remains separate and does not enter the normal Discord desktop bootstrap path.

## 📦 ASAR and BetterDiscord Ownership

### Archive resolution

- [`getOpenAsarArchivePath`](../src/injection.js) extracts the enclosing `.asar` path from `__filename`; it does not assume that OpenAsar is always `Resources/app.asar`.
- `global.oaArchivePath` records that exact archive.
- `global.oaHostResourcesPath` records its real host `Resources` directory, and `process.resourcesPath` is corrected to that directory for wrapped installs and system Electron.
- A standalone install therefore owns `Resources/app.asar`. A validated BetterDiscord wrapper owns `Resources/betterdiscord.app.asar`.

### Strict BetterDiscord wrapper contract

[`detectBetterDiscordWrapper`](../src/injection.js) accepts a wrapper only when all of the following agree:

- `Resources/app/.betterdiscord-inject.json` is valid JSON with schema `1`, owner `betterdiscord`, style `app-wrapper`, an accepted channel and mode, loader `index.js`, payload `../betterdiscord.app.asar`, and non-empty `bdPath` and `installationId`;
- `Resources/app/` contains exactly `.betterdiscord-inject.json`, `index.js`, and `package.json`;
- the loader is a regular file containing BetterDiscord's ownership token and nested payload path;
- `package.json` points to `index.js`;
- `Resources/betterdiscord.app.asar` is a regular file; and
- no competing top-level `Resources/app.asar` exists.

When that contract is valid, every OpenAsar retention or self-update path targets the nested payload. If OpenAsar is already running from `betterdiscord.app.asar` but wrapper validation fails, the fork refuses a top-level `app.asar` fallback. This prevents a partial or stale wrapper from silently changing archive ownership.

## ⚙️ Settings, Defaults, and Updater Selection

### Default filling and config-panel preservation

- `src/index.js` fills missing `openasar` defaults without replacing existing values. The fork-specific backend defaults are `VersionLock: ""` and `forceLegacyUpdater: false`.
- [`Settings.reload`](../src/appSettings.js) refreshes the on-disk object before forced updater-mode writes. [`Settings.save`](../src/appSettings.js) refuses to overwrite a file modified externally after the current snapshot was loaded.
- The hosted config panel does not currently know every fork-only key. [`mergeConfigFromPanel`](../src/config/index.js) restores `VersionLock` and `forceLegacyUpdater` from the current settings object when an older panel payload omits them.
- Detailed user-facing option semantics remain in [`docs/config.md`](config.md).

### `forceLegacyUpdater` contract

`openasar.forceLegacyUpdater` is platform-neutral. On every normal startup:

| `forceLegacyUpdater` | Persisted top-level setting | Selected mode |
|---|---|---|
| `true` | `USE_NEW_UPDATER: false` | Legacy updater |
| `false` | `USE_NEW_UPDATER: true` | New/native updater |

- [`enforceLegacyUpdaterSetting`](../src/index.js) performs this synchronization before Discord sees the updater choice.
- [`Settings.set`](../src/appSettings.js) blocks a later attempt to write `USE_NEW_UPDATER: true` while legacy mode is forced.
- Quit listeners reinforce the forced legacy value. The setting synchronization is not gated to macOS.
- Only the ShipIt/self-healing helper described below is macOS-only. Keep that platform boundary intact when changing the mode selector.

## 🔒 Shared `VersionLock` Contract

`openasar.VersionLock` is shared by both updater modes:

| Stored value | Meaning |
|---|---|
| absent, `false`, or `""` | Unlocked; updater behavior is handed back to Discord/OpenAsar. |
| `402` or `"402"` | Shorthand normalized to `0.0.402`. |
| `"0.0.402"`, `"0.1.10"`, or `"1.0.40"` | Absolute three-component version retained exactly. |

- Absolute components must be `0` or a non-zero decimal sequence without leading zeroes; numeric shorthand must also be a safe non-negative JavaScript integer.
- [`validateVersionLock`](../src/utils/versionLock.js) assigns `legacy` only when `forceLegacyUpdater === true`; otherwise an active lock requires the native updater.
- The normalized lock must exactly equal `buildInfo.version`.
- A mismatch shows a native dialog titled `OpenAsar` containing the running Discord binary version and configured `VersionLock`, then quits before any updater or Discord core work starts.
- Malformed settings, updater-mode disagreement, native updater initialization failure, manifest failure, and native `Pinned` failure also quit without silently continuing to latest.
- A lock freezes an already-installed matching binary. It does not install, upgrade, or downgrade Discord to the requested number.

Changing the lock therefore has two separate prerequisites:

1. install or retain a Discord binary whose `buildInfo.version` is the desired value;
2. set `VersionLock` to that same value.

If only the setting changes, the early binary comparison stops startup before manifest refresh or update work.

## 🔁 Legacy Updater Lock

The legacy path preserves Discord's existing update chain and changes only host selection:

- [`moduleUpdater.init`](../src/updater/moduleUpdater.js) receives the validated locked host version for that launch.
- An active lock adds to the existing `SKIP_HOST_UPDATE` decision, so `host.checkForUpdates()` is not called.
- `SKIP_MODULE_UPDATE` and `buildInfo.localModulesRoot` remain the only module-update gates. `VersionLock` never sets either one.
- The module endpoint, query parameters, installed-module manifest, pending directory, download/install events, splash progress, and retry lifecycle remain unchanged.
- Module queries continue to use the running `buildInfo.version` as `host_version`; the lock is already required to equal it.
- Platform mapping is shared with the native identity helper: `darwin -> osx`, `win32 -> win`, and Linux remains `linux`.

Normal legacy module storage remains under the active versioned user-data directory's `modules/` tree. If its `installed.json` is missing, the existing bootstrap manifest seeds module names before Discord checks their served versions.

An empty lock does not suppress host updates, even when `forceLegacyUpdater` keeps the client on the legacy updater.

## 📌 Native Updater Lock

### Pin application order

For a new-updater launch, [`configureNativeVersionLock`](../src/utils/nativeVersionLock.js) runs immediately after `updater.node` initialization:

- an active lock resolves an exact manifest and synchronously sends `SetManifests: ["Pinned", manifest]`;
- an empty lock synchronously sends `SetManifests: ["Pinned", null]` to clear prior native state;
- either operation must succeed before first-run or splash can call `UpdateToLatest`.

The cache file is not itself the native updater database. It is a validated raw manifest that OpenAsar reapplies; Discord persists its own updater state separately, including `installer.db`.

### Manifest cache and refresh

The exact cache is `<userData>/pinned_update.json`; there is no sidecar metadata file.

```text
read pinned_update.json
  -> exact valid cache: reuse it without a network request
  -> missing/damaged/unsafe/wrong target: request a fresh latest manifest
       -> server returns the lock version: validate and cache it directly
       -> server returns another version: validate it as a policy template
            -> request module versions for the locked host
            -> derive locked host/module full-package URLs
            -> stream and SHA-256 every full package
            -> build and validate a full-only manifest
            -> atomically replace the cache
  -> any unresolved failure: preserve the prior file and quit
```

The latest-manifest request includes channel, native platform, architecture, platform version, and the requested version. Discord treats that version as a hint; it is not a dependable historical-manifest API.

When the response targets another host version:

- the current response supplies manifest schema, `required_modules`, `required_update`, and metadata policy;
- `https://discord.com/api/modules/<channel>/versions.json?host_version=<lock>&platform=<platform>` supplies the currently served module versions for the target;
- OpenAsar derives every target full-package URL from the validated Discord distribution layout;
- the host plus every module reported by the target feed is downloaded and streamed through SHA-256;
- the reconstructed manifest contains full packages only and empty delta arrays.

A custom `NEW_UPDATE_ENDPOINT` affects the initial manifest request, but target module-version reconstruction still uses Discord's fixed API endpoint.

### Manifest trust boundaries

[`pinnedUpdateManifest.js`](../src/utils/pinnedUpdateManifest.js) enforces:

- a regular, non-symlink cache no larger than 2 MiB;
- HTTPS manifest requests, at most four redirects, a 10-second request timeout, and a 2 MiB response limit;
- Discord distribution package hosts under `discordapp.net`;
- channel, platform, architecture, target-version, relative-path, and traversal checks;
- conservative module names, unique required modules, required-module coherence, valid module versions, and exact 64-character SHA-256 values;
- a 1 GiB limit per streamed package and a strict 4 GiB aggregate hashing limit;
- `0600` temporary-file permissions and same-directory atomic rename.

macOS native identity uses `osx` plus `arm64` or `x64`; universal macOS archive paths are accepted for either architecture. Windows maps to `win` and `x64`/`x86`; the current Linux native identity is `linux`/`x64`.

### Repair without host activation

The native updater still runs `UpdateToLatest` against the pinned manifest. This is deliberate:

- missing modules, version directories, or updater database state can be downloaded again for the exact locked build;
- after `installer.db` is removed, Discord may need the complete matching host package to reconstruct a consistent native installation record;
- Discord can therefore stage a full app/host under `app-<version>` as well as modules;
- OpenAsar does not suppress or delete that staged host, because doing so would leave Discord's native database and managed files inconsistent.

Once the pinned version is ready, [`splash.initSplash`](../src/splash/index.js) passes `allowObsoleteHost: true` to `startCurrentVersion`:

- module paths are still committed;
- normal updater garbage collection still runs;
- macOS does not call `UpdateMacOSHostVersion` or start a ShipIt handoff;
- Windows and Linux do not quit and restart into the staged executable.

This suppresses activation, not repair. The installed `.app`/executable remains the binary that the user installed, and the binary-versus-lock gate repeats on the next launch.

### Lock changes and missing state

- Deleting `pinned_update.json` while the same lock remains active causes a fresh fetch or reconstruction and then re-pins.
- A damaged, unsafe, or wrong-version cache follows the same refresh path.
- Changing the lock invalidates the old cache, but only after the installed binary also matches the new lock.
- Deleting updater-managed module/version data or `installer.db` allows the pinned native updater to repair the same locked build.
- Setting `VersionLock` to `""` clears native `Pinned` state before normal native update work resumes.

## 🪵 Persistent State and Launch Logging

| Path | Owner and purpose |
|---|---|
| `<userData>/settings.json` | Discord/OpenAsar settings, including `openasar.VersionLock`, `openasar.forceLegacyUpdater`, and synchronized `USE_NEW_UPDATER`. |
| `<userData>/pinned_update.json` | OpenAsar's validated raw native manifest cache. |
| `<userData>/installer.db` | Discord native updater state; OpenAsar does not treat it as the manifest cache. |
| `<userData>/openasar-bootstrap/version-lock.log` | OpenAsar per-launch VersionLock/updater-mode JSON Lines log. |
| `<userData>/openasar-bootstrap/post-shipit-*` | macOS-only recovery helper, ownership state, pending state, PID, and logs. |
| `<userData>/openasar-bootstrap/recovery-runs/<handoffId>/app.asar` | Generation-owned temporary recovery payload for a macOS host handoff. |

[`initializeVersionLockLogger`](../src/utils/versionLockLogger.js) creates `openasar-bootstrap` when missing and overwrites `version-lock.log` at the beginning of every primary launch. The first record identifies channel, platform, architecture, running version, raw lock, `forceLegacyUpdater`, and `updaterMode: "legacy"` or `"new"`.

Later JSON Lines records cover validation, updater initialization, cache use/refresh/synthesis, native pin set/clear, host-activation policy, and fail-closed actions. Logging is platform-neutral and must remain independent from the macOS recovery helper even though both use `openasar-bootstrap`.

## 🍎 macOS Host-Update Self-Healing

This subsystem preserves OpenAsar after Discord replaces the macOS application bundle. It is separate from VersionLock and returns immediately on non-macOS platforms.

### Recovery modes

| Mode | Trigger | Responsibility |
|---|---|---|
| `shipit` | Unlocked native updater is about to call `UpdateMacOSHostVersion`. | Stage the current OpenAsar payload and follow the new-updater ShipIt handoff. |
| `legacy` | Electron's legacy updater emits `update-downloaded`. | Watch the final app bundle while `quitAndInstall()` performs host replacement. |
| `guard` | Startup, `before-quit`, or `will-quit` sees a matching pending handoff. | Recover a delayed/external replacement without turning a normal quit into an update. |

When `prepareMacOSPostHostUpdateHelper` acquires preparation ownership, it keeps the helper assets current; a guard launches only for a fresh `post-shipit-update-pending.json` with `pending: true`. If another process owns the preparation lock, that attempt exits without refreshing shared assets. Invalid, stale, or completed markers are reset to the safe inactive form.

### Bootstrap state

OpenAsar owns these channel-scoped files under `<userData>/openasar-bootstrap/`:

- `post-shipit-helper.zsh`
- `post-shipit-state.json`
- `post-shipit-update-pending.json`
- `post-shipit-helper.pid`
- `post-shipit-helper.log`
- `post-shipit-console.log`
- `post-shipit-arm.log`
- `.helper-preparation-lock`
- `recovery-runs/<handoffId>/app.asar`

`ShipIt_request.json` remains in the channel user-data root and is treated as ShipIt metadata, not proof by itself that an update is active.

### Handoff ownership

A newly published handoff is bound to a UUID `handoffId`, source Discord PID, target app, helper path, helper PID path, mode, payload path, and restart intent. A BetterDiscord handoff additionally carries channel, installation ID, nested target, and recovery-run identity. Preparation can reuse an already-live handoff only when that ownership identity matches.

- Preparation uses a lock directory and same-directory temporary files before publishing state and PID ownership.
- Unsafe symlinks and unexpected marker/file types are rejected.
- An exactly matching live helper can be reused, and its restart intent can be upgraded from false to true; it is never downgraded.
- A mismatched prior helper process group is stopped before replacement.
- The detached helper starts through `zsh -f` with a fixed system `PATH` and a small session/locale environment allowlist.
- The helper repeatedly rechecks handoff ID, source PID, its own PID, script path, and PID-file ownership before shared-state mutation.
- A superseded helper exits without deleting a newer generation's marker, PID, or recovery payload.

### ShipIt, restore, and relaunch

The helper changes only `launchAfterInstallation: true` to `false` in a matching ShipIt request, preventing ShipIt from racing OpenAsar restoration. It watches ShipIt when present; if ShipIt is not observed during the short startup grace but the target bundle has already changed, direct recovery can continue.

Before copying, the helper:

1. validates that it still owns the handoff;
2. waits for a stable target;
3. verifies its generation-owned payload;
4. verifies the final standalone or BetterDiscord target;
5. keeps a target backup; and
6. atomically renames the staged OpenAsar payload into place.

Only processes launched from the target app bundle are eligible for termination. The helper sends `TERM` before `KILL`, and relaunches only when the handoff contains current explicit restart intent. Ordinary user quits stay closed.

Owned recovery data and the pending marker are cleaned only while the helper still owns the same generation.

### BetterDiscord coordination

When the current archive belongs to a validated BetterDiscord wrapper, OpenAsar targets `Contents/Resources/betterdiscord.app.asar` and never falls back to top-level `app.asar`.

It coordinates with BetterDiscord's sibling `<userData>/betterdiscord-bootstrap/` state:

- `update-pending.json`
- `active-run`
- `wrapper-ready.json`
- `wrapper-result.json`
- `recovery-disabled`

The helper verifies marker schema, channel, installation ID, target app, nested path, recovery run, OpenAsar handoff ID, source PID, timestamps, and the regenerated wrapper before writing. A fresh matching `wrapper-result.json` with `outcome: "no-update"` ends the handoff without patching; it relaunches only when explicit restart intent requires it. `recovery-disabled` cancels without killing, copying, or relaunching.

If the wrapper marker is stale, mismatched, or never becomes valid, recovery fails closed rather than writing a top-level payload.

### Timing policy

- Source/local builds use a 90-second recovery window unless `scripts/pack.js` stamps another positive integer.
- Standalone guard mode keeps its 30-second watch.
- BetterDiscord coordination adds 10 seconds to matching recovery windows.
- The current GitHub workflow input default is 55 seconds, while builds made without a workflow/local override retain the 90-second source default.

## 🖥️ Unlocked Native Host Retention Outside macOS

Windows and Linux do not use the macOS helper:

- a standalone host transition backs up the staged host's `app.asar`, copies the current OpenAsar archive into that staged host, and launches the staged executable on quit;
- a validated BetterDiscord install revalidates the migrated wrapper, installation ID, and nested target during `will-quit` before replacing only `betterdiscord.app.asar`;
- if the current archive is nested but the migrated wrapper is invalid, OpenAsar refuses top-level fallback and still lets Discord control the host transition.

Locked native launches bypass this activation/restart branch through `allowObsoleteHost`; the cross-platform VersionLock module-commit behavior remains active.

## 🧭 Settings Sidebar Compatibility

[`src/mainWindow.js`](../src/mainWindow.js) maintains two independent DOM injections:

- [`injectVersionInfo`](../src/mainWindow.js) finds native compact/version/build text first, older native Host lines next, and BetterDiscord `.bd-version-info` only as a fallback.
- [`injectSettingsItem`](../src/mainWindow.js) prefers Discord's current Language & Time row, then the App Settings section, then older Advanced/layout fallbacks.

Both paths clone native nodes and classes instead of hard-coding a complete Discord component. The settings row receives stable OpenAsar IDs, the goose SVG, and the `DISCORD_UPDATED_QUOTES` IPC action that opens the config window.

The paths retry independently every 800 ms, so a missing footer does not prevent the settings item and a Discord/BetterDiscord rerender can be repaired on the next interval.

## 🔃 OpenAsar Self-Update

OpenAsar's ASAR self-updater is not Discord's host updater and is not VersionLock:

- [`src/asarUpdate.js`](../src/asarUpdate.js) derives the release channel from the stamped OpenAsar build version.
- Normal source builds default to `GooseMod/OpenAsar`; `scripts/pack.js --update-repo owner/repo` stamps another release repository.
- `--disable-autoupdate` stamps `global.oaDisableAutoUpdate`, which prevents this self-update path without disabling Discord host/module updating.
- A downloaded release must look like an ASAR before it is written.
- [`getOpenAsarArchivePath`](../src/injection.js) selects the exact running archive, so standalone installs update `app.asar` and validated BetterDiscord installs update `betterdiscord.app.asar`.

Do not use `VersionLock` to reason about this path: `VersionLock` controls Discord's host updater, while `openasar.autoupdate` and build stamps control OpenAsar's own ASAR replacement.

## 🏭 Packaging and Release Workflows

### Temporary-copy packer

[`scripts/pack.js`](../scripts/pack.js) never strips or stamps the tracked `src/` tree in place:

1. remove and recreate `tmp/pack-build`;
2. copy `src/` into `tmp/pack-build/src`;
3. stamp OpenAsar version, self-update disable state, update repository, and macOS recovery timeout;
4. protect template literals, including the embedded zsh helper, while stripping the copied tree;
5. pack the copy to the requested ASAR output.

[`scripts/strip.js`](../scripts/strip.js) remains the standalone in-place stripping utility and has the same template-literal protection. Current fork workflows use `scripts/pack.js` so their tracked source is not stripped in place.

Supported controls are:

- `--disable-autoupdate`
- `--update-repo <owner/repo>`
- `--version <value>`
- `--output <path>`
- `--macos-recovery-timeout-seconds <seconds>`
- `OPENASAR_MACOS_RECOVERY_TIMEOUT_SECONDS` when the CLI timeout is absent

[`local-build-no-autoupdate.zsh`](../local-build-no-autoupdate.zsh) produces `tmp/app.asar` with self-update disabled, a `nightly-<short-sha>-localtest` version, and optional `-mrts`/long-form recovery timeout forwarding.

### Workflow variants

| Workflow | Trigger | Build distinction |
|---|---|---|
| [`nightly.yml`](../.github/workflows/nightly.yml) | Manual | Normal self-update behavior and default update repo. |
| [`nightly-disable-autoupdate.yml`](../.github/workflows/nightly-disable-autoupdate.yml) | Manual | Packs with `--disable-autoupdate`; publishes the no-auto-update release variant. |
| [`nightly-custom-update-repo.yml`](../.github/workflows/nightly-custom-update-repo.yml) | `develop` pushes affecting source/scripts/workflows, or manual | Stamps `XxUnkn0wnxX/OpenAsar`; publishes the fork release variant. |

All three use `scripts/pack.js` and define Linux Stable/Canary plus Windows Stable/Canary startup smoke jobs. Current Linux archives are bootstrap packages, so the workflows run `updater_bootstrap --no-zenity`, discover the resulting `app-*` tree, inject the built ASAR, launch under Xvfb, poll for the bounded `ABRA` marker, and clean up the process explicitly.

The release jobs currently depend only on `build`; their smoke-test dependencies are commented out. The smoke jobs provide CI evidence but are not release gates unless those `needs` entries are restored.

## 🧪 Tests and Validation Boundaries

The architecture-critical suites are:

| Test file | Contract |
|---|---|
| [`tests/index-updater-mode.test.js`](../tests/index-updater-mode.test.js) | Bidirectional updater-mode persistence, startup order, and macOS guard gating. |
| [`tests/version-lock-validation.test.js`](../tests/version-lock-validation.test.js) | Empty/shorthand/absolute parsing, updater mode, mismatch handling, and dialog text. |
| [`tests/version-lock-module-updater.test.js`](../tests/version-lock-module-updater.test.js) | Legacy host suppression, module continuity, and macOS/Windows/Linux platform mapping. |
| [`tests/version-lock-bootstrap-order.test.js`](../tests/version-lock-bootstrap-order.test.js) | Native pin application and fail-closed ordering before first-run/splash. |
| [`tests/version-lock-native-updater.test.js`](../tests/version-lock-native-updater.test.js) | Native pin set/clear behavior and cross-platform host-activation suppression. |
| [`tests/version-lock-pinned-manifest.test.js`](../tests/version-lock-pinned-manifest.test.js) | Cache validation, exact refresh, synthesis, hashing, URL/size limits, atomic replacement, and platform identity. |
| [`tests/version-lock-logger.test.js`](../tests/version-lock-logger.test.js) | Bootstrap directory creation, launch-log replacement, and JSON Lines appends. |
| [`tests/splash-version-lock-updater-option.test.js`](../tests/splash-version-lock-updater-option.test.js) | `allowObsoleteHost` wiring for locked versus unlocked native launches. |
| [`tests/macos-post-shipit-owner.test.js`](../tests/macos-post-shipit-owner.test.js) | Helper syntax, handoff ownership, supersession, restart intent, pending guards, and BetterDiscord marker outcomes. |

Run the focused VersionLock/updater-mode set with:

```bash
node --test tests/index-updater-mode.test.js tests/version-lock-*.test.js
```

Run the full suite with:

```bash
node --test tests/*.test.js
```

These are source, filesystem, process, and updater mocks. They do not replace live Discord validation:

- only macOS has received live VersionLock testing;
- Windows and Linux lock behavior is implemented and fixture-tested but remains unverified against live Discord;
- the macOS helper tests do not execute a real ShipIt replacement or a real BetterDiscord regeneration;
- wrapper detection, Discord sidebar DOM drift, ASAR self-update, pack output, and workflow bootstrap behavior still need proportionate syntax/build/live or CI checks when changed.

## 🛡️ Maintenance Invariants and Known Limits

- Preserve startup order: updater-mode synchronization before `Constants`, then VersionLock validation and native pin set/clear before first-run or splash update work.
- Keep `forceLegacyUpdater` and VersionLock platform-neutral rather than gating them to macOS. Keep the separate recovery helper inside its explicit Darwin checks.
- Never treat `pinned_update.json`, `installer.db`, and a staged `app-<version>` host as interchangeable state.
- Never promise automatic host upgrade/downgrade from `VersionLock`; the binary must already match.
- Do not suppress normal legacy module checks merely because the host is locked.
- Do not suppress native same-version repair or delete the staged locked host behind Discord's updater database.
- Never fall back from an expected BetterDiscord nested payload to top-level `app.asar`.
- Preserve handoff/generation ownership checks before macOS process termination, copy, cleanup, or relaunch.
- Keep OpenAsar's ASAR self-update distinct from Discord host/module updates.
- Keep build stamping inside the temporary copied tree so a build cannot mutate tracked source.
- Update this document together with source and tests when a responsibility, state-file contract, updater ordering rule, platform boundary, or workflow trigger changes.

Discord does not provide a reliable historical-manifest-by-version service. Native manifest reconstruction works only while the target host and module artifacts remain served and the current manifest/feed conventions remain compatible. A first reconstruction can download the same large artifacts once for hashing and again when Discord performs repair. That cost and dependency are accepted in exchange for a validated exact pin; silent fallback to another Discord version is not.
