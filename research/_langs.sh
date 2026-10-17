#!/bin/bash
PROXY=http://192.168.80.1:7897
OUT=/mnt/e/project/quest/research/_out_mods.txt
: > $OUT

# fetch a lang file and report size, presence of key patterns
check_lang() { # repo branch path label
  echo "########## $4 :: $1/$3 ##########" >> $OUT
  curl -sS -m 40 -x $PROXY "https://raw.githubusercontent.com/$1/$2/$3" -o /tmp/lang.json
  if grep -q "404: Not Found" /tmp/lang.json 2>/dev/null; then echo "404" >> $OUT; return; fi
  python3 - "$4" <<'PY' >> $OUT
import json,sys
label=sys.argv[1]
d=json.load(open('/tmp/lang.json'))
keys=list(d.keys())
print('total keys:',len(keys))
for pat in ['itemGroup.','mod.','block.','item.','entity.','biome.','gui.','jei.','create.','config.']:
    n=sum(1 for k in keys if k.startswith(pat) or ('group.' in k and pat=='itemGroup.'))
    print(f'  startswith/{pat}:',sum(1 for k in keys if k.startswith(pat)))
# itemGroup keys
ig=[k for k in keys if k.startswith('itemGroup.')]
print('  itemGroup keys:',ig[:20])
PY
}

check_lang "Creators-of-Create/Create" "mc1.20.1/dev" "src/main/resources/assets/create/lang/en_us.json" "create"
check_lang "mezz/JustEnoughItems" "1.20.1" "Common/src/main/resources/assets/jei/lang/en_us.json" "jei"
check_lang "AlexModGuy/AlexsMobs" "1.20" "src/main/resources/assets/alexsmobs/lang/en_us.json" "alexsmobs"
check_lang "vectorwing/FarmersDelight" "1.20" "src/main/resources/assets/farmersdelight/lang/en_us.json" "farmersdelight"
cat $OUT
