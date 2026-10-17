########## myworldzycpc/snbt-js (main) README ##########
# SNBT-JS

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![npm version](https://img.shields.io/npm/v/snbt-js.svg)](https://www.npmjs.com/package/snbt-js)
[![Build Status](https://github.com/myworldzycpc/snbt-js/actions/workflows/tests.yml/badge.svg)](https://github.com/myworldzycpc/snbt-js/actions)

*(Formerly known as nbtcoder.js)*

A robust TypeScript library for parsing, manipulating, and serializing Minecraft's NBT (Named Binary Tag) format. 
Supports SNBT (Stringified NBT) with zero dependencies.

## Features

- 🚀 Full NBT specification implementation (Tags 1-12)
- ✨ Intuitive API for creating and modifying NBT structures
- 🔍 Path-based access using dot/bracket notation (`player.inventory[0].id`)
- 📝 Syntax-highlighted SNBT output for debugging
- ⚠️ Strict type validation and error handling
- 🌐 Browser and Node.js compatible

## Installation

```bash
npm install snbt-js
```

## Usage

### Parsing SNBT
```javascript
const { parseNbtString } = await import('snbt-js');

const nbtData = parseNbtString(`
{
  player: {
    name: "Steve",
    health: 20.0f,
    inventory: [
      { id: "minecraft:diamond_sword", Count: 1b },
      { id: "minecraft:cooked_beef", Count: 8b }
    ],
    position: [I; 125, 64, -312]
  }
}`);

console.log(nbtData.get('player.name').value); // "Steve"
```

### Creating NBT Programmatically
```javascript
const { NbtObject, NbtList, NbtString, NbtNumber } = await import('snbt-js');

const player = new NbtObject({
  name: new NbtString('Alex'),
  health: new NbtNumber(15.5, 'f'),
  skills: new NbtList([
    new NbtString('mining'),
    new NbtString('farming')
  ])
});

// Add armor items
player.addChild('armor', new NbtList([
  new NbtObject({ id: new NbtString('minecraft:iron_helmet') }),
  new NbtObject({ id: new NbtString('minecraft:diamond_chestplate') })
]));

console.log(player.text(true)); // Pretty-printed with syntax highlighting
```

### Modifying NBT
```javascript
// Update player position
player.set(['position', 0], new NbtNumber(130)); // X coordinate
player.set(['position', 1], new NbtNumber(65));  // Y coordinate
player.set(['position', 2], new NbtNumber(-305)); // Z coordinate

// Add new item to inventory
const inventory = player.get('inventory');
inventory.addChild(new NbtObject({
  id: new NbtString('minecraft:golden_apple'),
  Count: new NbtNumber(3, 'b')
}));
```

## API Documentation

[View full API documentation](./docs/api-reference.md)

## Contributing

Contributions are welcome! Please read the [contribution guidelines](CONTRIBUTING.md) before submitting pull requests.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Related Projects

- [Player Data Analyser](https://github.com/myworldzycpc/player-data-analyser) - Web-based player data analyser using this library
- [Bio Generator](https://github.com/TheRedMaker/theredmaker.github.io/tree/main/Biogenerator) - Summon command generator utilizing snbt-js (Formerly known as nbtcoder.js)

########## Nickid2018/snbt-grammar (master) README ##########
## snbt-grammar

SNBT (Stringified NBT) parser using PEG.

########## peunsu/ftb-snbt-lib (main) README ##########
# ftb-snbt-lib

![GitHub Release](https://img.shields.io/github/v/release/peunsu/ftb-snbt-lib?style=for-the-badge)

**A python library to parse, edit, and save FTB snbt tag.**

FTB snbt tag is a variant of the "vanilla" snbt tag, which uses newline(``\n``) instead of comma(``,``) as separator.

This is the example of FTB snbt tag:

```python
{
    some_tag: "some_value"
    another_tag: 1b
    list_tag: [
        "a"
        "b"
        "c"
    ]
}
```

**This library works with both FTB snbt tag and the vanilla snbt tag.** However, if you are finding the snbt library working perfectly for the "vanilla" snbt tag, use [nbtlib](https://github.com/vberlier/nbtlib) by [vberlier](https://github.com/vberlier).

## Installation

The package can be installed with ``pip``.

```bash
$ pip install ftb-snbt-lib
```

## Getting Started

* Import the library.

```python
>>> import ftb_snbt_lib as slib
```

* ``load(fp)``: Load the ftb snbt tag from a file (``fp``).<br>
The type of returned value is ``Compound``, a dictionary-like object.<br>
The ``Compound`` is containing values with **[tag data types](#data-types)** provided by this library.

```python
>>> some_snbt = slib.load(open("tests/some_file.snbt", "r", encoding="utf-8"))
>>> type(some_snbt)
<class 'ftb_snbt_lib.tag.Compound'>
>>> print(some_snbt)
Compound({'some_tag': String('some_value'), 'another_tag': Byte(1)})
```

* ``dump(tag, fp, comma_sep=False)``: Dump the ftb snbt tag to a file (``fp``).<br>
If you set ``comma_sep`` parameter to ``True``, the output snbt has comma separator ``,\n`` instead of non-comma separator ``\n``.

```python
>>> slib.dump(some_snbt, open("tests/some_file_copy.snbt", "w", encoding="utf-8"))
# File Output:
# {
#    some_tag: "some_value"
#    another_tag: 1b
# }
```

```python
>>> slib.dump(some_snbt, open("tests/some_file_copy.snbt", "w", encoding="utf-8"), comma_sep=True)
# File Output:
# {
#    some_tag: "some_value",
#    another_tag: 1b
# }
```

* ``loads(s)``: Load the ftb snbt tag from a string ``s``.<br>
The type of returned value is ``Compound``.

```python
>>> another_snbt = slib.loads('''
... {
...     some_tag: "some_value"
...     another_tag: 1b
... }
... ''')
>>> type(another_snbt)
<class 'ftb_snbt_lib.tag.Compound'>
>>> print(another_snbt)
Compound({'some_tag': String('some_value'), 'another_tag': Byte(1)})
```

* ``dumps(tag, comma_sep=False)``: Dump the ftb snbt tag to a string.<br>
If you set ``comma_sep`` parameter to ``True``, the output snbt has comma separator ``,\n`` instead of non-comma separator ``\n``.

```python
>>> dumped_snbt = slib.dumps(another_snbt)
>>> print(dumped_snbt)
{
    some_tag: "some_value"
    another_tag: 1b
}
```

```python
>>> dumped_snbt = slib.dumps(another_snbt, comma_sep=True)
>>> print(dumped_snbt)
{
    some_tag: "some_value",
    another_tag: 1b
}
```

* Edit the snbt tag. As its type is ``Compound``, it can be edited like a dictionary.<br>
The inserted or replace values should be any of **[tag data types](#data-types)** provided by this library.

```python
>>> another_snbt["some_tag"] = slib.String("another_value")
```

* When editing the ``List``, a list-like object, its elements must have **the same type**.<br>
For instance, ``List[Byte(1), Byte(2), Byte(3)]`` must contain **only** the ``Byte`` type object, so the other types like ``Integer`` or ``String`` **cannot be added or replaced** in it.

* When editing the ``Array``, a list-like object with **a fixed length**, its elements must have **the same type**, and that type must **match the element type defined in the array**.<br>
For instance, ``IntArray`` with a length of 3 must contain **three** ``Integer`` type objects, so **adding new objects, removing existing objects, and replacing with other type objects are not allowed**.

* Save the edited snbt tag to a json file.

```python
>>> import json
>>> json.dump(another_snbt, open("tests/test.json", "w", encoding="utf-8"), indent=4, ensure_ascii=False)
```

## Data Types

| Type | Description | Format | Example |
| - | - | - | - |
| Byte | A signed 8-bit integer.<br>Range: ``-128`` ~ ``127`` | ``<number>b`` | ``12b``, ``-35b`` |
| Short | A signed 16-bit integer.<br>Range: ``-32,768`` ~ ``32,767`` | ``<number>s`` | ``132s``, ``-243s`` |
| Integer | A signed 32-bit integer.<br>Range: ``-2,147,483,647`` ~ ``2,147,483,647`` | ``<number>`` | ``12345`` |
| Long | A signed 64-bit integer.<br>Range: ``9,223,372,036,854,775,808`` ~ ``9,223,372,036,854,775,807`` | ``<number>L`` | ``12345L`` |
| Float | A 32-bit, single-precision floating-point number.<br>Range: ``-3.4E+38`` ~ ``+3.4E+38`` | ``<number>f`` | ``12.345f``, ``1.0E-6f`` |
| Double | A 64-bit, double-precision floating-point number.<br>Range: ``-1.7E+308`` ~ ``+1.7E+308`` | ``<number>d`` | ``12.345d``, ``1.0E-6d`` |
| Bool | A boolean data type.<br>``0`` for ``false``, ``1`` for ``true``. | ``false``, ``true`` | ``true`` |
| String | A sequence of characters. | A string enclosed in **double quotes ``""``**.<br>Nested double quotes can be included within a string using a **escaping character ``\"``**. | `"Hello, World!"`,<br>`"Say \"Hello, World!\""` |
| List | An ordered list of tags.<br>The tags must be of **the same type**, determined by the first tag in the list. | Unnamed tags enclosed in square brackets and delimited by **newline** characters (``\n``). | <pre>[<br>    3.2d<br>    1.4d<br>    ...<br>]</pre> |
| Array | An ordered list of 8-bit(``ByteArray``), 32-bit(``IntArray``), 64-bit(``LongArray``) integers. | ``<array_prefix>;`` followed by an ordered list of tags enclosed in square brackets and delimited by **newline** characters (``\n``).<br>Valid array prefixes are ``B``(Byte), ``I``(Integer), and ``L``(Long). | <pre>[B;<br>    12b<br>    -35b<br>    ...<br>]</pre> |
| Compound | An ordered list of attribute-value pairs.<br>Each tag can be of **any type**. | Named tags enclosed in curly braces and delimited by commas or **newline** characters (``\n``).<br>The key (tag name) can be unquoted i
########## Krutoy242/ftbq-nbt (master) README ##########
# NBT

## 🍴 Fork changes

Enchanced parse / stringify functions to make package working with [FTBQuests](https://www.curseforge.com/minecraft/mc-mods/ftb-quests-forge) mod's `.snbt` file format. See real usage examples [here](https://github.com/Krutoy242/mc-tools/blob/8fcf43db35218c5003e1711a1da1316d18ebe397/packages/utils/src/mods/ftbquests.ts#L109-L119).

## Description

[![npm](https://img.shields.io/npm/v/ftbq-nbt.svg)](https://www.npmjs.com/package/ftbq-nbt)
[![downloads](https://img.shields.io/npm/dm/ftbq-nbt.svg)](https://www.npmjs.com/package/ftbq-nbt)

An easy to use encoder and decoder for the [NBT format](https://wiki.vg/NBT).

NBT compound tags are represented as plain JavaScript objects. The `Byte`, `Short`,
`Int` and `Float` number types are wrapped in custom classes since JavaScript
does not support them directly.

Node 10.4 or higher is required for BigInts, which are used to represent 64 bit integers.

## Usage

```js
const { encode, decode, Byte, Short, Int, Float } = require("nbt-ts")

const buffer = encode("root", {
    byte: new Byte(-1),
    short: new Short(65535),
    int: new Int(-2147483648),
    long: 0x7fffffffffffffffn,
    float: new Float(0.75),
    double: 0.1 + 0.2,
    string: "Hello world",
    list: ["item 1", "item 2"],
    compound: {
        byteArray: Buffer.from([0x80, 0x40, 0x20]),
        // Int8Array does work here too
        intArray: new Int32Array([1, 2, 3, 4]),
        longArray: new BigInt64Array([1n, 2n, 3n, 4n])
    },
})

decode(Buffer.from("02000973686F7274546573747FFF", "hex"))
// → { name: 'shortTest', value: Short { value: 32767 }, length: 14 }

// Encode unnamed tag
encode(null, "a")
// → <Buffer 08 00 01 61>

// Decode unnamed tag
decode(Buffer.from("08000161", "hex"), { unnamed: true })
// → { name: null, value: 'a', length: 4 }
```

Note that the `encode` function accepts both unsigned numbers such as `255` and signed
numbers like `-1` which are essentially the same in the case of a 8 bit integer.
However when decoded, they will always have the signed representation. If you want
to convert a number to the unsigned representation, you might do something like this:

```js
value & 0xff   // for bytes
value & 0xffff // for shorts
value >>> 0    // for ints
BigInt.asUintN(64, value) // for longs
// or
value & 0xffffffffffffffffn
```

## SNBT

The NBT format also has a more user-friendly variant in plain text. This format
is referred to as **SNBT**, short for **stringified NBT**.
Here are all the types represented in SNBT:

```
{
    byte: 1b, short: 1s, int: 1, long: 1l,
    float: 0.5f, double: 0.5,
    string: "Hello world",
    list: [{}, {}],
    compound: {
        byteArray: [B; 128, 64, 32],
        intArray: [I; 1, 2, 3, 4],
        longArray: [L; 1, 2, 3, 4]
    }
}
```

Here is an example how you can stringify or parse SNBT:

```js
const { stringify, parse } = require("nbt-ts")

const tag = parse(`{'Flying' :1b , unquoted: hello} `)
// → { Flying: Byte { value: 1 }, unquoted: 'hello' }

stringify(tag)
// → '{Flying:1b,unquoted:"hello"}'
```

## Related projects

- [`mc-chat-format`](https://github.com/janispritzkau/mc-chat-format).
    Converts and formats Minecraft's JSON Chat components.
- [`mcproto`](https://github.com/janispritzkau/mcproto) (Minecraft protocol implementation)
- [`rcon-client`](https://github.com/janispritzkau/rcon-client)

########## PrismarineJS/node-mojangson (master) README ##########
# node-mojangson
[![NPM version](https://badge.fury.io/js/mojangson.svg)](http://badge.fury.io/js/mojangson) ![CI](https://github.com/PrismarineJS/node-mojangson/workflows/CI/badge.svg)

node-mojangson is a mojangson parser.

## Mojangson specification
Mojangson is mojang's variant of json. It is basically json with the following changes :

 * array can be indexed (example : `[0:"v1",1:"v2",2:"v3"]`)
 * array and object can have trailing comma (example : `[5,4,3,]` and `{"a":5,"b":6,}`)
 * there can be string without quote (example : `{mykey:myvalue}`)
 * numbers can be suffixed by b, s, l, f, d, i or the same in upper case (example : `{number:5b}`)
 * mojangson stays a superset of json : every json is a mojangson

 Reference https://minecraft.gamepedia.com/Commands#Data_tags

## Parser
This parser is build using nearley.

See the [grammar](grammar.ne) and the examples in the [test](test/test.js) for more information.

## Usage
Usage example :

```js
const mojangson = require('mojangson')

const data = mojangson.parse('{mykey:myvalue}')

// print the parsed data
console.log(data)

// print the simplified data
condole.log(mojangson.simplify(data))
```

The provided method `mojangson.parse` return a javascript object corresponding to the mojangson passed in input.

`mojangson.simplify` returns a simplified representation : keep only the value to remove one level. This loses the types so you cannot use the resulting representation to write it back.

`mojangson.stringify` will take a js object with types and values for mojangson and make it into a normalized mojangson string

```js
const mojangson = require('mojangson')
const data = mojangson.stringify({ type: 'list', value: { type: 'string', value: [ 'z1', 'z2' ] } })
console.log(data) // => [z1,z2]
```

Another example, the provided method `mojangson.normalize` takes a string of mojangson and normalizes it in the shortest way to retain all data. Comparing it to the original will tell you if you have the shortest equivalent to a string of mojangson.

```js
const mojangson = require('mojangson')
const original = '[0:"z1",1:"z2"]'
const data = mojangson.normalize(original)
console.log(data) // => [z1,z2]
const optimized = original === data
console.log(optimized) // => false
```


## History

### 2.1.0
* [Fix parser failure on whitespace before closing brace (#57)](https://github.com/PrismarineJS/node-mojangson/commit/e107e605553de62301002ac5d6b8575f5647a4ca) (thanks @Copilot)
* [Fix simplify() to fully unwrap byteArray, intArray, and longArray (#54)](https://github.com/PrismarineJS/node-mojangson/commit/7482d623c9199bf8a582fb723d1d598d4feba938) (thanks @Copilot)
* [Add support for single-quoted strings in mojangson parser (#53)](https://github.com/PrismarineJS/node-mojangson/commit/fa153c7b626f51303810fde805d3f62a14974a98) (thanks @Copilot)
* [node 22 (#51)](https://github.com/PrismarineJS/node-mojangson/commit/8526165d95483002dbcdab09391196a0a3a1a543) (thanks @rom1504)

### 2.0.4

* fix publish

### 2.0.3

* Fix simplifying of arrays throwing error (@Lianecx)
* Escape new lines in text (@U9G)

### 2.0.2

* fixes issue where strings starting with a number would be parsed as a number (@U9G)

### 2.0.1

* fix escaping some chars in mojangson.stringify (@U9G)
* update grammar for unicode escaped strings (@U9G)
* fix parsing of escaped characters (@Majorblake)

### 2.0.0

* Changes output format to include types (@Karang)
* add simplify function
* Add stringify function to go back to mojangson (@U9G)

### 1.1.1

* Fix empty string parsing (thanks @IdanHo)

### 1.1.0

* switch to nearley parser for a better handling for mojangson (thanks @Karang)

### 1.0.0

* stop printing error

### 0.2.4

* add support for double and int

### 0.2.3

* fix release about grammar.js still containing the cli

### 0.2.2

* disable jison cli to make mojangson compatible with browserify

### 0.2.1

* fix state conflict due to recent trailing comma fix

### 0.2.0

* Rename npm package to mojangson
* fix trailing comma in arrays

### 0.1.1

* better error displaying

### 0.1

* First release, basic functionality

########## prismarinejs/prismarine-nbt (master) README ##########
# Prismarine-NBT
[![NPM version](https://img.shields.io/npm/v/prismarine-nbt.svg)](http://npmjs.com/package/prismarine-nbt)
[![Build Status](https://github.com/PrismarineJS/prismarine-nbt/workflows/CI/badge.svg)](https://github.com/PrismarineJS/prismarine-nbt/actions?query=workflow%3A%22CI%22)
[![Discord](https://img.shields.io/badge/chat-on%20discord-brightgreen.svg)](https://discord.gg/GsEFRM8)
[![Try it on gitpod](https://img.shields.io/badge/try-on%20gitpod-brightgreen.svg)](https://gitpod.io/#https://github.com/PrismarineJS/prismarine-nbt)

Prismarine-NBT is a JavaScript parser and serializer for [NBT](http://wiki.vg/NBT) archives. It supports big, little, and little-varint encoded NBT files.


## Usage

#### as a async promise

```js
const fs = require('fs')
const nbt = require('prismarine-nbt')

async function main(file) {
  const buffer = fs.readFileSync(file)
  const { parsed, type } = await nbt.parse(buffer)

  console.log('As JSON', JSON.stringify(parsed))
  console.log('Simplified', nbt.simplify(parsed))

  // Write it back
  fs.createWriteStream('bigtest.nbt')
    .write(nbt.writeUncompressed(parsed, type))
}
main('bigtest.nbt')
```

#### as a callback

```js
var fs = require('fs'),
    nbt = require('prismarine-nbt');

fs.readFile('bigtest.nbt', function(error, data) {
    if (error) throw error;

    nbt.parse(data, function(error, data) {
        console.log(data.value.stringTest.value);
        console.log(data.value['nested compound test'].value);
    });
});
```

If the data is gzipped, it is automatically decompressed, for the buffer see metadata.buffer

## API

### parse(data, [format]): Promise<{ parsed, type, metadata: { size, buffer? } }>
### parse(data, [format,] callback)

Takes an optionally compressed `data` buffer (`Buffer` or `ArrayBuffer`) and reads the nbt data.

If the endian `format` is known, it can be specified as 'big', 'little' or 'littleVarint'. If not specified, the library will
try to sequentially load as big, little and little varint until the parse is successful. The deduced type is returned as `type`.

Minecraft Java Edition uses big-endian format, and Bedrock uses little-endian.

### writeUncompressed(value, format='big')

Returns a buffer with a serialized nbt `value`. 

### parseUncompressed(data, format='big', options?= {noArraySizeCheck?: boolean})

Takes a buffer `data` and returns a parsed nbt value.

The `options` parameter is optional. When `noArraySizeCheck` is `true`, an array size check is disabled which allows for parsing of large arrays.

### parseAs(data, type, options?= {noArraySizeCheck?: boolean})

Takes a buffer `data` and returns a parsed nbt value. If the buffer is gzipped, it will unzip the data first.

The `options` parameter is optional. When `noArraySizeCheck` is `true`, an array size check is disabled which allows for parsing of large arrays.


### simplify(nbt)

Returns a simplified nbt representation : keep only the value to remove one level.
This loses the types so you cannot use the resulting representation to write it back to nbt.

### equal(nbt1, nbt2)

Checks whether two NBT objects are equal, returns a boolean.

### protos : { big, little, littleVarint }

Provides compiled protodef instances used to parse and serialize nbt

### proto

Provide the big-endian protodef instance used to parse and serialize nbt.

### protoLE

Provide the little-endian protodef instance used to parse and serialize little endian nbt.

### addTypesToCompiler (type, compiler)
Adds prismarine-nbt types to an ProtoDef compiler instance

### addTypesToInterpreter (type, interperter)
Adds prismarine-nbt types to a ProtoDef interpreter instance

### builder

Provides a way to build complex nbt structures simply:

```js
const nbt = require('prismarine-nbt')
const tag = nbt.comp({
  Air: nbt.short(300),
  Armor: nbt.list(nbt.comp([
    { Count: nbt.byte(0), Damage: nbt.short(0), Name: nbt.string('a') },
    { Count: nbt.byte(0), Damage: nbt.short(0), Name: nbt.string('b') },
    { Count: nbt.byte(0), Damage: nbt.short(0), Name: nbt.string('c') }
  ]))
})
nbt.writeUncompressed(tag) // now do something with this nbt buffer...
```

See [index.d.ts](typings/index.d.ts#L69) for methods

## Browser usage

For webpack usage, see an example configuration [here](https://github.com/PrismarineJS/prismarine-web-client/blob/master/webpack.common.js#L28).

For a web bundle with browserify (after you ran `npm install prismarine-nbt` in your project):
```
npx browserify -r prismarine-nbt -o pnbt.js
```
```html
<script src="./pnbt.js"></script>
<script>
  const nbt = require('prismarine-nbt')
  fetch('test.nbt').then(resp => resp.arrayBuffer())
    .then(nbt.parse).then(console.log)
</script>
```

########## Tryanks/python-snbtlib (main) README ##########
# Snbtlib
[![PyPI version](https://badge.fury.io/py/snbtlib.svg)](https://badge.fury.io/py/snbtlib)

## Installation
```
pip install snbtlib
```

## Usage
```python
import snbtlib
from pathlib import Path

# Reading Text to JSON
json = snbtlib.loads(Path('quest.snbt').read_text(encoding='utf-8'))

# Dumping JSON to Text
text = snbtlib.dumps(json, compact=False)  # When compact is True, the output will be compatible with Version 1.12 and below
Path('quest.snbt').write_text(text, encoding='utf-8')
```
