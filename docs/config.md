# OpenAsar Config

OpenAsar stores its config under the `openasar` object in the current Discord channel's `settings.json`. Missing default keys are filled on startup without overwriting existing values.

## Config UI Mapping

Some settings are exposed through the OpenAsar config window:

- `Focus` -> `cmdPreset`
- `No Track` -> `noTrack`
- `Disable Typing` -> `noTyping`
- `Splash Theming` -> `themeSync`
- `Quickstart` -> `quickstart`
- `Multi Instance` -> `multiInstance`
- `Theming` editor -> `css`

Other keys are manual/backend options that can be edited directly in `settings.json`.

## Options

### `setup`

Marks whether the OpenAsar config window has been opened before. If this is not `true`, OpenAsar opens the config window after Discord finishes showing.

### `cmdPreset`

Chooses built-in Chromium/Electron command-line flag presets. `base` is always applied, then this preset is added.

- `perf`: GPU and responsiveness-focused flags.
- `battery`: lower-power flags.

### `customFlags`

Adds extra Chromium/Electron command-line flags. The value is split by spaces and appended after the built-in presets.

### `noTrack`

When not set to `false`, OpenAsar blocks Discord science/metrics API requests and disables Sentry from the injected main-window code.

### `noTyping`

When set to `true`, OpenAsar blocks Discord typing API requests.

### `themeSync`

When not set to `false`, OpenAsar copies Discord theme CSS variables into `userDataCache.json` and injects them into OpenAsar-owned windows such as the config window.

### `quickstart`

When set to `true`, OpenAsar skips more of the splash wait and launches the main Discord window faster.

### `multiInstance`

When set to `true`, OpenAsar allows more than one Discord instance. Otherwise it uses Discord/Electron's single-instance lock.

### `domOptimizer`

When not set to `false`, OpenAsar enables its DOM optimizer, which delays some activity-related DOM removals in the main window.

### `autoupdate`

Controls OpenAsar's own ASAR updater. When not set to `false`, OpenAsar tries to download the latest configured OpenAsar build after Discord shows. This is separate from Discord's host/client updater. OpenAsar updates the archive it is currently running from: `Resources/app.asar` normally, or `Resources/betterdiscord.app.asar` when a validated BetterDiscord wrapper owns `Resources/app/`.

### `css`

Injects custom CSS into the main Discord window. If `css` or `js` is set, OpenAsar removes Discord's content security policy response header so injection can work.

### `js`

Runs custom JavaScript in the main Discord window after DOM ready. If `js` or `css` is set, OpenAsar removes Discord's content security policy response header so injection can work.

### `forceLegacyUpdater`

`openasar.forceLegacyUpdater` is a platform-neutral updater-mode selector. On every startup, OpenAsar ensures the top-level setting is its inverse: `forceLegacyUpdater: false` writes `USE_NEW_UPDATER: true`, while `forceLegacyUpdater: true` writes `USE_NEW_UPDATER: false`. When legacy mode is forced, OpenAsar also blocks Discord attempts to save the setting back to `true`, reinforces `false` during quit, and uses the legacy updater path where Discord still supports it.

Only the separate OpenAsar host-update self-healing/bootstrap helper is restricted to macOS; `forceLegacyUpdater` and its `USE_NEW_UPDATER` synchronization are not macOS-gated.

On macOS, update recovery is active for both updater modes. Startup only refreshes the helper assets; a quit guard owns one handoff generation and starts recovery when needed. With BetterDiscord, OpenAsar waits for the matching source Discord PID, handoff ID, recovery run, and wrapper-ready marker before restoring only the nested payload. A normal user quit stays closed, while a current updater restart signal may relaunch Discord. A matching BetterDiscord no-update result ends the handoff without patching or relaunching.

### `VersionLock`

`openasar.VersionLock` freezes an already-installed Discord host version. It does not install, upgrade, or downgrade the Discord application.

Accepted forms:

- `""` (default), `false`, or absent: unlocked.
- Number shorthand: `402`, or string shorthand: `"402"`: normalized to absolute `0.0.402`.
- Absolute canonical version string: `"0.0.402"`, `"0.1.10"`, or `"1.0.40"`.
- Each component must be `0` or a non-zero integer without leading zeroes.

Common behavior:

- The normalized lock must exactly match the running Discord binary (`buildInfo.version`).
- A mismatch shows an `OpenAsar` native error dialog containing both versions, then quits before updater initialization, first-run work, splash, modules, or the Discord client can start.
- Automatic host upgrade/downgrade is intentionally out of scope. Install the required Discord version first, then set `VersionLock` to that same version.
- Setting `VersionLock` to `""` returns updater selection to normal. If the native updater starts, OpenAsar also clears any persisted native `Pinned` manifest before normal update work.

Updater-mode selection:

- `forceLegacyUpdater: true` plus a non-empty lock uses the legacy updater lock.
- `forceLegacyUpdater: false` persists top-level `USE_NEW_UPDATER: true` during startup; with a non-empty lock, the new/native updater is then locked to the matching running version.
- `forceLegacyUpdater: true` is still required for legacy locking. A lock never silently converts a forced-legacy launch into native mode.

Legacy updater behavior:

- With legacy lock applied, only host checks are skipped (`host.checkForUpdates`); modules are still evaluated as today via existing `SKIP_MODULE_UPDATE` and `localModulesRoot` behavior.
- Module endpoint (`/modules/<channel>/versions.json`) and query (`host_version=<running version>&platform=<native platform>`) stay unchanged.
- Module download/install lifecycle, `checked` events, and splash events stay unchanged.
- `VersionLock` never sets `SKIP_MODULE_UPDATE`. Keep top-level `SKIP_MODULE_UPDATE` absent or `false`, and do not configure `localModulesRoot`, when normal Discord module downloads are required.

New/native updater behavior:

- The raw pinned manifest is stored at `<user-data>/pinned_update.json`; no sidecar file is used.
- Every locked launch reads and validates that local file for the exact channel, platform, architecture, host version, required modules, package URLs, and SHA-256 values.
- A valid exact cache is reused without contacting the manifest server.
- A missing, damaged, oversized, unsafe, or wrong-version cache triggers a fresh HTTPS manifest lookup using the current channel, native platform/architecture, platform version, and requested `VersionLock`.
- If Discord returns that exact version, the downloaded manifest is validated and used directly.
- If Discord returns another current/rollout version, OpenAsar uses it only as a schema and required-module policy template. It requests the target version's module list, derives full-package URLs for the locked host and modules, streams every package to calculate its real SHA-256, and builds a full-only manifest with no delta packages.
- The complete result is validated and written to a same-directory temporary file before it atomically replaces `pinned_update.json`. A failed request, hash, limit, validation, or write leaves the previous cache untouched and fails closed.
- OpenAsar sends the validated manifest to Discord as native `Pinned` state before `firstRun` or splash can issue `UpdateToLatest`. Discord may then restore updater-managed host/module files described by that exact manifest, but it cannot select another host version.
- When updater state such as `installer.db` is missing, Discord's native updater still requires the matching host package to rebuild a consistent installation record. It may therefore download and stage a complete app/host under `app-<version>` as well as the required modules. OpenAsar does not suppress that download because doing so would prevent a clean native-state rebuild.
- On every locked new-updater launch, OpenAsar starts the pinned version with host activation disabled. On macOS it does not request `UpdateMacOSHostVersion`/ShipIt activation; on Windows and Linux it does not quit and restart into the staged executable. Module paths are still committed and normal updater garbage collection still runs.
- The staged host is deliberately retained. Removing it while the native database says it is installed creates inconsistent updater state and can prevent later repair or unlock.
- If target artifacts are unavailable, native pinning fails, or validation fails, OpenAsar logs the reason, shows an error, and quits without starting an update. It never uses another host version while locked.

Discord does not expose a dependable historical-manifest-by-version API. The `version` request value is only a hint, so OpenAsar reconstructs an exact full-only manifest only while Discord still serves all target host/module packages. The first reconstruction can be large and may download the target packages once for hashing before Discord's native updater downloads the packages it needs to install. Later launches reuse the valid local manifest without that network work.

Changing `VersionLock` invalidates a cache for the old target. If the installed Discord binary was changed to the same new value, OpenAsar builds or fetches a replacement manifest and re-locks. If the binary was not changed, the earlier binary-versus-lock check quits before any manifest or updater work.

Version-lock logging:

- `<user-data>/openasar-bootstrap/version-lock.log` is created on all supported platforms; the bootstrap directory is created when missing.
- The file is overwritten on each primary launch and uses JSON Lines records.
- The first record clearly includes `"updaterMode":"legacy"` or `"updaterMode":"new"`, followed by validation, manifest refresh/synthesis, pin set/clear, host-activation policy, and failure events for that launch.

Platform status:

- VersionLock parsing, logging, legacy platform mapping, native manifest validation, and native pin application are implemented without a macOS-only gate and are intended to work on macOS, Windows, and Linux.
- Only macOS has been tested with VersionLock. Windows and Linux support is currently theoretical and should be treated as untested.
- The separate OpenAsar host-update self-healing/recovery helper remains macOS-only.

Examples:

- Valid unlocked: `openasar.VersionLock: ""`
- Valid shorthand: `openasar.VersionLock: 402` or `openasar.VersionLock: "402"` -> normalized to `0.0.402` at runtime.
- Valid absolute: `openasar.VersionLock: "0.1.10"`
- Legacy lock: `openasar.forceLegacyUpdater: true`, `openasar.VersionLock: "0.0.402"`
- New/native lock: `openasar.forceLegacyUpdater: false`, `openasar.VersionLock: "0.0.402"`

For a legacy lock on Discord `0.0.402`, merge these keys into the existing `openasar` object:

```json
{
  "openasar": {
    "forceLegacyUpdater": true,
    "VersionLock": "0.0.402"
  }
}
```

For new/native mode, use the same example with `"forceLegacyUpdater": false`.

Set `"VersionLock": ""` to return to normal updater behavior. Do not replace the rest of the existing `settings.json` with this partial example.

Update `<user-data>/settings.json` to enable, disable, or change this lock.
