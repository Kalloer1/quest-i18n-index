#!/bin/bash
GH="/mnt/c/Program Files/GitHub CLI/gh.exe"
gh() { "$GH" "$@"; }
OUT=/mnt/e/project/quest/research/_out_repos.txt
: > $OUT

repos=(
 "SpyglassMC/Spyglass"
 "myworldzycpc/snbt-js"
 "Nickid2018/snbt-grammar"
 "prismarinejs/prismarine-nbt"
 "PrismarineJS/node-mojangson"
 "Krutoy242/ftbq-nbt"
 "Hardel-DW/voxelio"
 "janispritzkau/nbt-ts"
 "EngineHub/nbt-ts"
 "peunsu/ftb-snbt-lib"
 "JiLiGuLuTeam/snbtlib"
 "Tryanks/python-snbtlib"
 "Tnze/snbt-vscode"
)

for r in "${repos[@]}"; do
  echo "########## $r ##########" >> $OUT
  gh api "repos/$r" --jq '"stars=\(.stargazers_count) forks=\(.forks_count) open_issues=\(.open_issues_count) pushed=\(.pushed_at) created=\(.created_at) default_branch=\(.default_branch) license=\(.license.spdx_id) archived=\(.archived) desc=\(.description)"' >> $OUT 2>&1
done
cat $OUT
