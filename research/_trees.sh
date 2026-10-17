#!/bin/bash
GH="/mnt/c/Program Files/GitHub CLI/gh.exe"
gh() { "$GH" "$@"; }
OUT=/mnt/e/project/quest/research/_out_trees.txt
: > $OUT
tree() {
  echo "########## $1 ($2) ##########" >> $OUT
  gh api "repos/$1/git/trees/$2?recursive=1" --jq '.tree[] | select(.type=="blob") | .path' >> $OUT 2>&1
}
tree "Nickid2018/snbt-grammar" "master"
tree "myworldzycpc/snbt-js" "main"
tree "peunsu/ftb-snbt-lib" "main"
tree "Tryanks/python-snbtlib" "main"
tree "Krutoy242/ftbq-nbt" "master"
cat $OUT
