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

When set to `true`, OpenAsar forces `USE_NEW_UPDATER` to behave as false, blocks Discord attempts to save it back to `true`, writes top-level `USE_NEW_UPDATER: false` during startup and quit, and uses the legacy updater path where Discord still supports it.

On macOS, update recovery is active for both updater modes. Startup only refreshes the helper assets; a quit guard owns one handoff generation and starts recovery when needed. With BetterDiscord, OpenAsar waits for the matching source Discord PID, handoff ID, recovery run, and wrapper-ready marker before restoring only the nested payload. A normal user quit stays closed, while a current updater restart signal may relaunch Discord. A matching BetterDiscord no-update result ends the handoff without patching or relaunching.

### `VersionLock`

`openasar.VersionLock` is a normal/manual lock field used by legacy updater lock mode.

Accepted forms:

- `""` (default), `false`, or absent: unlocked/no legacy effect.
- Number shorthand: `402`, or string shorthand: `"402"`: normalized to absolute `0.0.402`.
- Absolute canonical version string: `"0.0.402"`, `"0.1.10"`, or `"1.0.40"`.
- Each component must be `0` or a non-zero integer without leading zeroes.

Behavior:

- Legacy lock is only applied when `openasar.forceLegacyUpdater` is `true`.
- When applied, the normalized value must exactly match `buildInfo.version`; otherwise OpenAsar shows a dialog, logs an error, and quits before updater/splash.
- With legacy lock applied, only host checks are skipped (`host.checkForUpdates`); modules are still evaluated as today via existing `SKIP_MODULE_UPDATE` and `localModulesRoot` behavior.
- Module endpoint (`/modules/<channel>/versions.json`) and query (`host_version=<running version>&platform=osx`) stay unchanged.
- Module download/install lifecycle, `checked` events, and splash events stay unchanged.
- `VersionLock` never sets `SKIP_MODULE_UPDATE`. Keep top-level `SKIP_MODULE_UPDATE` absent or `false`, and do not configure `localModulesRoot`, when normal Discord module downloads are required.

When `openasar.forceLegacyUpdater` is `false`, `VersionLock` is passed through unchanged and has no phase-1 effect. This preserves the value for future new-updater lock support.

Examples:

- Valid unlocked: `openasar.VersionLock: ""`
- Valid shorthand: `openasar.VersionLock: 402` or `openasar.VersionLock: "402"` -> normalized to `0.0.402` at runtime.
- Valid absolute: `openasar.VersionLock: "0.1.10"`
- Valid absolute with force: `openasar.forceLegacyUpdater: true`, `openasar.VersionLock: "0.1.10"`
- Pass-through: `openasar.forceLegacyUpdater: false`, `openasar.VersionLock: "0.1.10"`

For a legacy lock on Discord `0.0.402`, merge these keys into the existing `openasar` object:

```json
{
  "openasar": {
    "forceLegacyUpdater": true,
    "VersionLock": "0.0.402"
  }
}
```

Set `"VersionLock": ""` to return to normal updater behavior. Do not replace the rest of the existing `settings.json` with this partial example.

Update `/settings.json` at `<user-data>/settings.json` to enable/disable or change this lock.
