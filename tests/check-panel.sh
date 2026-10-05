#!/bin/bash
# Integration check in a separate Quickshell instance, with temporary state
# and a stubbed curl (see tests/curl-fixture). Does not touch the installed
# plugin or make real network requests.
set -euo pipefail
plugin_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
test_dir=$(mktemp -d /tmp/rain-radar-denmark-test.XXXXXX)
trap 'rm -rf -- "$test_dir"' EXIT
mkdir -p "$test_dir/bin"
cp "$plugin_dir/tests/panel.qml" "$test_dir/shell.qml"
cp "$plugin_dir/tests/curl-fixture" "$test_dir/bin/curl"
chmod +x "$test_dir/bin/curl"
ln -s "$plugin_dir" "$test_dir/Plugin"
for module in Commons Ui services; do
  ln -s "$OMARCHY_PATH/shell/$module" "$test_dir/$module"
done
# A name-only Omarchy Weather location, as `omarchy-weather-location --set Aarhus`
# writes it: the panel must resolve it through its city list.
mkdir -p "$test_dir/state/omarchy/settings"
echo '{"name": "Aarhus"}' > "$test_dir/state/omarchy/settings/weather.json"
PATH="$test_dir/bin:$PATH" XDG_STATE_HOME="$test_dir/state" \
  timeout 30s quickshell -p "$test_dir" --no-color
