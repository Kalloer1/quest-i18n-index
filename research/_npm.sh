#!/bin/bash
GH="/mnt/c/Program Files/GitHub CLI/gh.exe"
gh() { "$GH" "$@"; }
PROXY=http://192.168.80.1:7897
OUT=/mnt/e/project/quest/research/_out_npm.txt
: > $OUT

fetch_pkg() {
  local pkg="$1"
  local enc=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$pkg")
  curl -sS -m 40 -x $PROXY "https://registry.npmjs.org/$enc" -o /tmp/pkg.json
  python3 - "$pkg" <<'PY' >> $OUT
import json,sys
pkg=sys.argv[1]
try:
    d=json.load(open('/tmp/pkg.json'))
except Exception as e:
    print(pkg,'ERR',e); sys.exit()
latest=d.get('dist-tags',{}).get('latest')
print('=====',pkg,'=====')
print(' latest:',latest)
print(' repo:',(d.get('repository') or {}).get('url') if isinstance(d.get('repository'),dict) else d.get('repository'))
print(' homepage:',d.get('homepage'))
print(' created:',d.get('time',{}).get('created'))
print(' modified:',d.get('time',{}).get('modified'))
print(' versions:',len(d.get('versions',{})))
print(' license:',d.get('license'))
vd=d.get('versions',{}).get(latest,{})
print(' deps:',vd.get('dependencies'))
print(' keywords:',d.get('keywords'))
PY
}

for p in "@spyglassmc/nbt" "snbt-js" "@mc-wiki/snbt" "prismarine-nbt" "node-mojangson" "ftbq-nbt" "@voxelio/snbt" "nbt-ts" "@enginehub/nbt-ts" "mc-snbt-parser" "parsenbt-js"; do
  fetch_pkg "$p"
done
cat $OUT
