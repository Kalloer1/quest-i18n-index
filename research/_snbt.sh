#!/bin/bash
export PATH="$PATH:/mnt/c/Program Files/GitHub CLI"
GH="/mnt/c/Program Files/GitHub CLI/gh.exe"
gh() { "$GH" "$@"; }
PROXY=http://192.168.80.1:7897
echo "===== GH search snbt (repos) ====="
gh api "search/repositories?q=snbt&sort=stars&per_page=30" --jq '.items[] | [.full_name, (.stargazers_count|tostring), .pushed_at, (.language//"-"), (.description//"-")] | @tsv'
echo ""
echo "===== GH search snbt parser ====="
gh api "search/repositories?q=snbt+parser&sort=stars&per_page=30" --jq '.items[] | [.full_name, (.stargazers_count|tostring), .pushed_at, (.language//"-"), (.description//"-")] | @tsv'
echo ""
echo "===== GH search snbt language:JavaScript ====="
gh api "search/repositories?q=snbt+language:JavaScript&sort=stars&per_page=20" --jq '.items[] | [.full_name, (.stargazers_count|tostring), .pushed_at, (.description//"-")] | @tsv'
echo ""
echo "===== npm registry search snbt ====="
curl -sS -m 40 -x $PROXY "https://registry.npmjs.org/-/v1/search?text=snbt&size=25" -o /tmp/snbt_npm.json
python3 - <<'PY'
import json
d=json.load(open('/tmp/snbt_npm.json'))
print('total',d['total'])
for o in d['objects']:
    p=o['package']
    print(p['name'],'|',p.get('version'),'|',p.get('date','')[:10],'|',(p.get('description') or '')[:100])
PY
echo ""
echo "===== npm registry search nbt ====="
curl -sS -m 40 -x $PROXY "https://registry.npmjs.org/-/v1/search?text=nbt&size=25" -o /tmp/nbt_npm.json
python3 - <<'PY'
import json
d=json.load(open('/tmp/nbt_npm.json'))
print('total',d['total'])
for o in d['objects']:
    p=o['package']
    print(p['name'],'|',p.get('version'),'|',p.get('date','')[:10],'|',(p.get('description') or '')[:100])
PY
