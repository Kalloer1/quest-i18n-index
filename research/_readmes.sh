#!/bin/bash
PROXY=http://192.168.80.1:7897
OUT=/mnt/e/project/quest/research/_out_readmes.txt
: > $OUT

getreadme() {
  local repo="$1"; local branch="$2"
  echo "########## $repo ($branch) README ##########" >> $OUT
  for f in README.md readme.md README.MD README.rst README.txt; do
    curl -sS -m 30 -x $PROXY "https://raw.githubusercontent.com/$repo/$branch/$f" -o /tmp/rm.txt
    if ! grep -q "404: Not Found" /tmp/rm.txt 2>/dev/null && [ -s /tmp/rm.txt ]; then
      head -c 6000 /tmp/rm.txt >> $OUT
      echo "" >> $OUT
      return
    fi
  done
  echo "(no readme found)" >> $OUT
}

getreadme "myworldzycpc/snbt-js" "main"
getreadme "Nickid2018/snbt-grammar" "master"
getreadme "peunsu/ftb-snbt-lib" "main"
getreadme "Krutoy242/ftbq-nbt" "master"
getreadme "PrismarineJS/node-mojangson" "master"
getreadme "prismarinejs/prismarine-nbt" "master"
getreadme "Tryanks/python-snbtlib" "main"
cat $OUT
