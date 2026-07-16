# Changelog

## 2026-07-16

### BetterDiscord wrapper compatibility

- Added strict BetterDiscord wrapper detection and nested OpenAsar self/host-update recovery.
- Coordinated macOS bootstrap recovery so OpenAsar waits for BetterDiscord's matching ready marker and never falls back to top-level `app.asar` while that handoff is expected.
- End matching macOS recovery cleanly when BetterDiscord reports that no Discord replacement occurred, avoiding the second wrapper wait and unnecessary relaunch attempt.
- Fixed build stripping so the embedded post-ShipIt helper keeps its timestamp parser intact and accepts valid BetterDiscord wrapper-ready markers.
- Launch the detached macOS helper with `zsh -f` in both its shebang and spawn path, and give it a fixed system `PATH` plus a small macOS session/locale environment allowlist instead of inherited shell customization.
- Made the helper PID own its detached process group, so stopping the validated PID also terminates helper child processes before the PID file is removed.
- Documented the [Discord install manager](https://github.com/XxUnkn0wnxX/Scripts/blob/develop/shell/discord_install_manager.zsh) [`--BD` behavior](https://github.com/XxUnkn0wnxX/Scripts/blob/develop/docs/discord-install-manager.md): preserve valid wrappers, fall back to `app.asar` when absent, and reject `--update`.

## 2026-07-06

### macOS updater override

- Added a backend-only `openasar.forceLegacyUpdater` setting so OpenAsar can ignore Discord's forced `USE_NEW_UPDATER` flag and stay on the legacy updater path when intentionally testing or pinning host builds after bootstrap.
- Blocked Discord settings writes that try to set `USE_NEW_UPDATER: true` while `openasar.forceLegacyUpdater` is enabled, so the flag is forced false before it reaches `settings.json`.
- Wrote top-level `USE_NEW_UPDATER: false` during OpenAsar startup and again during quit whenever `openasar.forceLegacyUpdater` is enabled, so Discord cannot leave the setting true across launches without OpenAsar correcting it again.
- Reloaded `settings.json` before these forced writes so Discord changes made after startup are preserved while the updater flag is corrected.
- Filled missing OpenAsar default settings into the current channel's `settings.json` on startup without overwriting existing values, so backend-only keys like `forceLegacyUpdater` are visible and easy to edit.
- Added `docs/config.md` with a concise reference for the `openasar` settings block.
- Reused the macOS post-host-update helper for legacy updater host replacements; new updater launches the helper in `shipit` mode, while legacy updater launches it in `legacy` mode and waits for the final app bundle to be replaced before restoring OpenAsar.
- Armed the macOS helper during startup and quit when `forceLegacyUpdater` is enabled, giving Discord's delayed legacy host replacement a bounded watch window before stock `app.asar` can remain installed.
- Logged helper preparation/start reasons in `openasar-bootstrap/post-shipit-helper.log` and append-only `post-shipit-arm.log`, making startup, `before-quit`, `will-quit`, and updater-triggered helper launches visible during testing.
- Ensured each helper arm terminates any older helper processes for the same channel before starting a replacement, and made pidfile cleanup ignore pidfiles now owned by a newer helper.
- Limited startup/quit guard patching to real updater handoffs by requiring a fresh per-channel pending-update marker before replacing a changed target `app.asar`; normal startup/quit still refreshes the per-channel `openasar-bootstrap` folder and helper assets, keeps `post-shipit-update-pending.json` initialized as `pending: false`, only starts the helper for `pending: true`, resets finished/stale markers back to `false`, and marker-backed guards wait only 30 seconds.
- Preserved backend-only OpenAsar config keys when the CDN-hosted config panel saves, so older panel payloads do not drop `forceLegacyUpdater`.

## 2026-07-04

### macOS ShipIt bootstrap follow-up

- Reworked macOS host-update retention so OpenAsar no longer copies itself into Discord's staged `app-*` host bundle before ShipIt finishes the handoff.
- Added a temporary `openasar-bootstrap/` helper under the Discord channel's App Support folder; it disables ShipIt's auto relaunch, waits for the real ShipIt process when present, patches the final `/Applications` app bundle, and relaunches Discord.
- Treated leftover `ShipIt_request.json` as metadata only, so stale request files do not block direct patching when no active ShipIt process appears.
- Added fresh per-run summary and verbose console logs for the bootstrap helper.

## 2026-06-15

### Sidebar compatibility follow-up

- Updated the OpenAsar settings sidebar injection in `src/mainWindow.js` so it prefers Discord's current `language_and_time_panel` row before falling back to the older `App Settings` / `Advanced` anchors.
- Kept the existing DOM-clone approach and footer version entry behavior intact while supporting both the newer `_panel` sidebar IDs and the older `_sidebar_item` IDs.

## 2026-05-17

### BetterDiscord version detection follow-up

- Hardened the OpenAsar version-entry injection in `src/mainWindow.js` so it identifies the real native Discord version row by content instead of relying on selector order alone.
- Added content-based matching for native compact version rows and older Host-line layouts so the footer injection stays compatible with plain Discord, upstream BetterDiscord, and the local BetterDiscord fork.
- Kept the BetterDiscord-specific `.bd-version-info` fallbacks only after native Discord targets are checked, which avoids attaching OpenAsar to BetterDiscord-owned version rows when both layouts are present.
- Ignored `local-build-no-autoupdate.zsh` in `.gitignore` so the local no-auto-update helper stays repo-local during testing.

## 2026-05-11

### Linux stable workflow follow-up

- Investigated the Linux stable GitHub Actions smoke tests after the previous Canary bootstrap fix and confirmed the current stable tarball now also behaves like a bootstrap package instead of a ready-to-patch app tree.
- Reworked the Linux stable setup steps in all three workflow variants so CI runs `updater_bootstrap --no-zenity`, locates the installed `app-*` directory, and copies `app.asar` into the discovered resources directory instead of assuming `Discord/resources/app.asar` already exists.
- Updated the Linux stable startup smoke tests to discover the installed Discord executable from the bootstrapped install tree before launching it under `xvfb-run`.
- Kept the added install-tree and extracted-tree failure output so future Linux stable packaging changes are easier to diagnose from workflow logs.

### Upstream merge follow-up

- Merged the latest `upstream/main` changes into `develop`.
- Picked up the upstream splash updater change that sets `skip_host_delta` back to `true` during retry handling in `src/splash/index.js`.

## 2026-04-26

### Canary workflow timeout follow-up

- Investigated a failing `Nightly Fork` GitHub Actions run where `Test Linux Canary` printed `ABRA` successfully but still timed out in the startup check step.
- Confirmed the failure was not a cold-start regression in OpenAsar itself; the CI check was hanging behind `xvfb-run` after the expected startup marker had already been emitted.
- Reworked the Linux startup smoke-test steps in all three workflow variants so Discord is launched in the background, the logs are polled for `ABRA`, and the process is cleaned up explicitly once the success marker is observed.
- Kept the existing 3-minute job timeout while adding a shorter inner timeout for the log poll, so future hangs fail quickly with the captured client output.

### Sidebar cold-start follow-up

- Reduced the BetterDiscord sidebar fix in `src/mainWindow.js` so it stays much closer to upstream's original interval-based settings injection flow.
- Kept only the minimum behavior needed for cold-start reliability: the OpenAsar sidebar entry now retries independently from the footer/version injection path.
- Kept the OpenAsar entry anchored in the `App Settings` section when that section is present, with the older `Advanced` fallbacks still available for Discord layouts that need them.
- Kept the custom goose icon on the cloned OpenAsar settings item.
- Verified the trimmed DOM-only path with a fresh no-auto-update local build and confirmed the OpenAsar entry now survives a cold boot with BetterDiscord enabled.

### Linux Canary workflow follow-up

- Investigated the failing Linux Canary GitHub Actions jobs on the fork after the workflow was updated to detect the extracted directory dynamically.
- Confirmed the current Linux Canary tarball is no longer a full app bundle and instead only contains the bootstrap package with `updater_bootstrap`, `discord-canary`, and related wrapper files.
- Verified locally that Linux stable still ships a full `Discord/resources/app.asar` layout, which explains why the stable workflow kept passing while Canary broke.
- Reworked the Linux Canary setup steps in all three workflow variants so CI now treats the Canary tarball as a bootstrap installer instead of a ready-to-patch app bundle.
- Added bootstrap-based Canary installation in CI by running `updater_bootstrap --no-zenity` into `~/.config/discordcanary`, then locating the installed `app-*` directory before copying `app.asar`.
- Updated the Linux Canary startup smoke tests to launch the installed `DiscordCanary` binary from the bootstrapped app directory instead of assuming the executable lives in the extracted tarball.
- Kept extra extracted-tree and install-tree debug output so future Linux Canary packaging changes are easier to diagnose from workflow logs.

## 2026-04-23

### Sidebar follow-up

- Refined the BetterDiscord-safe sidebar anchor search so OpenAsar prefers the `App Settings` section when it is present instead of attaching near BetterDiscord's own section.
- Kept the broader fallback chain in `src/mainWindow.js` for Discord layouts where `App Settings` is missing or renamed, including the existing `Advanced`, `Developer`, and `Log Out` fallbacks.
- Verified the revised sidebar hook against captured Discord settings DOM snapshots and packed a fresh local test archive at `tmp/app.asar`.
- Cherry-picked [PR #234](https://github.com/GooseMod/OpenAsar/pull/234)'s sidebar icon change from SoCuul without rewriting authorship, so the current settings entry keeps the existing injection logic while using the custom goose icon.

## 2026-04-17

### BetterDiscord settings compatibility

- Investigated [OpenAsar issue #222](https://github.com/GooseMod/OpenAsar/issues/222), [PR #225](https://github.com/GooseMod/OpenAsar/pull/225), and the [TirOFlanc/OpenAsar fork](https://github.com/TirOFlanc/OpenAsar).
- Reviewed the local BetterDiscord codebase to understand how it patches Discord's settings UI.
- Identified the main failure mode in `src/mainWindow.js`: OpenAsar's settings item injection was incorrectly gated behind version/footer detection.
- Reworked the settings injection flow in `src/mainWindow.js` so version injection and menu item injection are independent.
- Kept the injected menu entry based on cloning native Discord sidebar items instead of creating fresh nodes with hard-coded Discord classes.
- Added a settings-area-scoped `MutationObserver` so the OpenAsar item can be restored after BetterDiscord or Discord rerenders the sidebar.
- Kept a slower interval fallback to retry injection without relying on a global full-page observer.
- Evaluated a hybrid settings injection path that patched Discord's internal settings layout alongside DOM injection.
- Matched the current BetterDiscord settings DOM where `Advanced` is absent and `Developer` / `Log Out` are the stable fallback anchors.
- Identified that local test builds were being overwritten on first launch by OpenAsar's self-updater.
- Added a build-time auto-update flag so local test archives can be packed with self-updates disabled intentionally.
- Kept the default source behavior with self-updates enabled unless the build flag is explicitly set.
- Added `scripts/pack.js` to build local `app.asar` files with options such as `--disable-autoupdate` and `--update-repo owner/repo`.
- Confirmed the DOM-only settings injection works once local test builds stop being overwritten by the self-updater.
- Reverted the experimental hybrid settings patch and kept the DOM-only fix for the final code path.
- Local test build command:
  `node scripts/pack.js --disable-autoupdate --version nightly-$(git rev-parse --short HEAD)-localtest --output tmp/app.asar`
- Added optional fork-oriented GitHub workflow templates for no-auto-update artifacts and custom update repos while leaving the main upstream nightly workflow unchanged.
- Found and fixed a pack-time stamping bug where `scripts/pack.js` only replaced the first `<updateRepo>` placeholder even though `src/index.js` used that placeholder more than once.
- Fixed that placeholder bug by changing the pack step to replace all `<updateRepo>` occurrences so packed builds do not keep half-stamped fallback logic.
- Found and fixed a runtime fallback bug where the initial `oaUpdateRepo` comparison collapsed stamped fork builds back to `GooseMod/OpenAsar` instead of preserving the custom repo.
- Fixed that runtime bug by switching the fallback check to `stampedUpdateRepo.startsWith('<')`, so unpacked source still defaults upstream while packed builds keep the explicitly stamped fork repo.
- Verified the fork-update path by packing a test build with `--disable-autoupdate --update-repo XxUnkn0wnxX/OpenAsar` and confirming the stamped temp build source kept the custom repo value.
- Expanded the two optional fork workflows so they follow the main nightly pipeline shape more closely instead of only uploading artifacts.
- Matched the extra workflows to the main pipeline by adding the same Linux stable/canary and Windows stable/canary startup smoke-test jobs plus the same release structure.
- Kept the intended workflow differences narrow: one packs with `--disable-autoupdate` and publishes `nightly-no-autoupdate`, and the other packs with `--update-repo owner/repo` and publishes `nightly-fork`.
- Verified the updated file with `node -c src/mainWindow.js`.
- Verified the repo still packs locally by producing `tmp/app.asar`.
