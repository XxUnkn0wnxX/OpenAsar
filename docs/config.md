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

When set to `true`, OpenAsar forces `USE_NEW_UPDATER` to behave as false, blocks Discord attempts to save it back to `true`, writes top-level `USE_NEW_UPDATER: false` during startup and quit, and uses the legacy updater path where Discord still supports it. On macOS, OpenAsar also arms a short-lived helper during startup/quit so app-bundle replacements can be patched back after Discord hands off to the updater. When BetterDiscord recovery is expected, the helper waits for its matching wrapper-ready marker and restores OpenAsar only to the nested payload; otherwise the existing standalone `app.asar` path is unchanged.
