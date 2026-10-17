#!/bin/bash
PROXY=http://192.168.80.1:7897
OUT=/mnt/e/project/quest/research/_out_src.txt
: > $OUT
get() { # repo branch path
  echo "########## $1/$3 ($2) ##########" >> $OUT
  curl -sS -m 30 -x $PROXY "https://raw.githubusercontent.com/$1/$2/$3" >> $OUT
  echo "" >> $OUT
}
get "Krutoy242/ftbq-nbt" "master" "examples/snbt.ts"
get "Krutoy242/ftbq-nbt" "master" "examples/test_crlf.snbt"
get "Krutoy242/ftbq-nbt" "master" "examples/test_tabs.snbt"
get "Krutoy242/ftbq-nbt" "master" "src/snbt.ts"
get "Nickid2018/snbt-grammar" "master" "src/index.ts"
get "Nickid2018/snbt-grammar" "master" "src/snbt-parser.base.ts"
get "myworldzycpc/snbt-js" "main" "test/serializer-tests.ts"
cat $OUT
