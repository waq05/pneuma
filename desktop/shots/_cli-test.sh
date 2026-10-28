set -e
cd /d/dsc
TMP=$(mktemp -d)
export HOME="$TMP" USERPROFILE="$TMP"
mkdir -p "$TMP/demo-bundle/plugins"
cat > "$TMP/demo-bundle/package.json" <<'EOF'
{ "name": "demo-bundle", "version": "1.0.0", "engines": { "dsh": ">=0.2.0-0 <0.3.0" }, "dsh": { "bundle": { "patch": "./cordis.patch.yml" } } }
EOF
cat > "$TMP/demo-bundle/cordis.patch.yml" <<'EOF'
- insert:
    - id: demo-hello
      name: ./plugins/hello.js
EOF
cat > "$TMP/demo-bundle/plugins/hello.js" <<'EOF'
export const name = 'bundle-hello'
export const inject = ['tools']
export function apply(ctx) { return () => undefined }
EOF
WIN=$(cygpath -m "$TMP/demo-bundle")
echo "bundle at $WIN"
node bin/dsc.js plugin add "file:$WIN" --profile test 2>&1 | tail -8
echo '--- list:'
node bin/dsc.js plugin list --profile test 2>&1 | tail -6
echo '--- profile manifest:'
cat "$TMP/.dsc/profiles/test/package.json"
