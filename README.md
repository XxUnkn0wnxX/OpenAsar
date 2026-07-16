# OpenAsar &nbsp;<sup><sub>/ˈoʊpən ʌsɑr/ &nbsp;*(o-pen as-are)*</sup></sub>
![Nightly Status](https://github.com/XxUnkn0wnxX/OpenAsar/actions/workflows/nightly-custom-update-repo.yml/badge.svg) [![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)]([https://choosealicense.com/licenses/agpl/l](https://choosealicense.com/licenses/agpl-3.0/))

**An open-source alternative of Discord desktop's `app.asar`**

## Features
- **:rocket: Startup Speed**: ~2x faster startup times (up to ~4x with experimental config)
- **:chart_with_upwards_trend: Performance**: OpenAsar can make your client feel snappier (scrolling, switching channels, etc)
- **:paintbrush: Splash Theming**: Easy theming for your splash which works with most themes for any client mod
- **:electric_plug: Drop-in**: Replace one file and it's installed, that's it (same with uninstall)
- **:gear: Configurable**: Adds many config options for Discord and OpenAsar enhancements (see config section)
- **:cloud: Lightweight**: <1% of Discord's original size (9mb -> ~50kb)
- **:shield: No Tracking**: Removes Discord's built-in tracking for crashes and errors in the asar (not app itself)
- **:jigsaw: BetterDiscord Compatible**: Detects the BetterDiscord fork's validated app wrapper, keeps OpenAsar in `Resources/betterdiscord.app.asar`, and retains normal `Resources/app.asar` behavior when no wrapper is present
- **:package: macOS Bootstrap Safe**: Handles Discord's newer ShipIt host-app bootstrap and legacy macOS host replacements with a PID-managed temporary helper that also stops its helper descendants on shutdown

### See [FAQ](faq.md) for more details

<br>

## [Install Guide](https://github.com/GooseMod/OpenAsar/wiki/Install-Guide)

The [Discord install manager](https://github.com/XxUnkn0wnxX/Scripts/blob/develop/shell/discord_install_manager.zsh) integration is macOS-only ([documentation](https://github.com/XxUnkn0wnxX/Scripts/blob/develop/docs/discord-install-manager.md)). Its `--BD` mode requires `--openasar` or `--openasar-source`, preserves a valid BetterDiscord wrapper, and replaces only its nested OpenAsar payload. It falls back to `Resources/app.asar` only when no wrapper is present, refuses partial wrappers, and cannot be combined with `--update`.

## Local Build
See [docs/build.md](docs/build.md) for local build instructions, including local test builds with `--disable-autoupdate`.

## Changelog
See [docs/changelog.md](docs/changelog.md) for the current local work log / changelog.

## Config

You can configure OpenAsar by clicking the "OpenAsar..." version info in the bottom of your settings sidebar, which will open the config window.

See [docs/config.md](docs/config.md) for a reference of the settings OpenAsar stores under the `openasar` object.
