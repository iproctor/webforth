const leb = require('leb128')
const fs = require('fs')
function leb128(n) {
  return leb.signed.encode(n)
}
// wasm instruction helpers stay the same
const i32 = {
  const: n => [0x41, ...leb128(n)],
  store: addr => [0x36, 0x02, ...leb128(addr)],
  load: addr => [0x28, 0x02, ...leb128(addr)],
  add: [0x6a],
  sub: [0x6b],
  mul: [0x6c],

  // comparison operators
  eq: [0x46],
  ne: [0x47],
  lt_s: [0x48],  // signed
  lt_u: [0x49],  // unsigned
  gt_s: [0x4a],  // signed >
  gt_u: [0x4b],  // unsigned >
  le_s: [0x4c],  // signed <=
  le_u: [0x4d],  // unsigned <=
  ge_s: [0x4e],  // signed >=
  ge_u: [0x4f],  // unsigned >=

  // bitwise ops (CRUCIAL for forth tbh)
  and: [0x71],
  or: [0x72],
  xor: [0x73],
  shl: [0x74],  // left shift
  shr_s: [0x75], // signed right shift
  shr_u: [0x76], // unsigned right shift
  rotl: [0x77],  // rotate left
  rotr: [0x78],  // rotate right

  // division & remainder
  div_s: [0x6d], // signed division
  div_u: [0x6e], // unsigned division
  rem_s: [0x6f], // signed remainder
  rem_u: [0x70], // unsigned remainder

  // bit counting
  clz: [0x67],    // count leading zeros
  ctz: [0x68],    // count trailing zeros
  popcnt: [0x69], // population count (number of 1 bits)

  // type conversion (might need these later)
  wrap_i64: [0xa7],     // i64 -> i32
  trunc_f32_s: [0xa8],  // f32 -> i32 signed
  trunc_f32_u: [0xa9],  // f32 -> i32 unsigned
  trunc_f64_s: [0xaa],  // f64 -> i32 signed
  trunc_f64_u: [0xab],  // f64 -> i32 unsigned

  // extended memory ops
  load8_s: [0x2c],  // load 8 bits as signed
  load8_u: [0x2d],  // load 8 bits as unsigned
  load16_s: [0x2e], // load 16 bits as signed
  load16_u: [0x2f], // load 16 bits as unsigned
  store8: [0x3a],   // store 8 bits
  store16: [0x3b],  // store 16 bits
}
const wasm = {
  call: idx => [0x10, ...leb128(idx)],
  ifEmpty: [0x04, 0x40], // if with empty block
  else: [0x05],
  endBlock: [0x0b],
}

const VAR_START = 1024
const SP_ADDR = VAR_START - 4
const STACK_START = VAR_START - 8

function varAddr(n) {
  return VAR_START + 4 * n
}

const readSp = [
  ...i32.const(SP_ADDR),
  ...i32.load()
]
const derefSp = offset => [
  ...readSp,
  ...i32.load(offset)
]
const nth = n => derefSp(n * 4)
const derefWriteSp = (offset, val) => [
  ...readSp,
  ...val,
  ...i32.store(offset)
]
const writeNth = (n, val) => derefWriteSp(n * 4, val)

const setSp = val => [
  ...i32.const(SP_ADDR),
  ...val,
  ...i32.store(0)
]

// Positive means deeper into the stack
const moveSp = offset => setSp([
  ...readSp,
  ...i32.const(offset),
  ...i32.add,
])
const drop = n => moveSp(n * 4)
const pushSp = val => [
  ...writeNth(0, val),
  ...moveSp(-4),
]

function binPrim(op) {
  return [
    ...writeNth(2, [
      ...nth(1),
      ...nth(2),
      ...op,
    ]),
    ...drop(1),
  ]
}
function unPrim(op) {
  return writeNth(1, [
    ...nth(1),
    ...op
  ])
}

const prims = {
  // ( n -- )
  dup: pushSp(nth(1)),

  // ( a b -- b a )
  swap: [
    ...readSp,
    ...nth(1),
    ...readSp,
    ...nth(2),
    ...i32.store(0),
    ...i32.store(4),
  ],

  // ( a b c -- b c a )
  rot: [
    ...readSp,
    ...readSp,
    ...readSp,
    ...nth(1), // c
    ...i32.store(4),
    ...nth(2), // b
    ...i32.store(8),
    ...nth(3), /// a
    ...i32.store(0),
  ],

  // ( a b -- a+b )
  '+': binPrim(i32.add),

  // ( a b -- a-b )
  '-': binPrim(i32.sub),

  // ( a b -- a*b )
  '*': binPrim(i32.mul),

    // comparison (all leave flag on stack)
  '=':  binPrim(i32.eq),
  '<>': binPrim(i32.ne),
  '<':  binPrim(i32.lt_s),
  'u<': binPrim(i32.lt_u),
  '>':  binPrim(i32.gt_s),
  'u>': binPrim(i32.gt_u),
  '<=': binPrim(i32.le_s),
  'u<=':binPrim(i32.le_u),
  '>=': binPrim(i32.ge_s),
  'u>=':binPrim(i32.ge_u),

  // bitwise ops
  'and': binPrim(i32.and),
  'or':  binPrim(i32.or),
  'xor': binPrim(i32.xor),
  'lshift': binPrim(i32.shl),
  'rshift': binPrim(i32.shr_u), // forth traditionally uses unsigned
  'rotate': binPrim(i32.rotl),  // might want both rotl/rotr tbh

  // division & remainder
  '/': binPrim(i32.div_s),
  'u/': binPrim(i32.div_u),
  'mod': binPrim(i32.rem_s),
  'umod': binPrim(i32.rem_u),

  // bit counting (unary prims)
  'clz': unPrim(i32.clz),
  'ctz': unPrim(i32.ctz),
  'popcnt': unPrim(i32.popcnt),

  // ( val addr -- )
  '!': [
    ...nth(1), // addr
    ...nth(2), // val
    ...i32.store(0), // lets assume we are using real memory addresses without VAR offset
    ...drop(2)
  ],

  '@': writeNth(1, [
    ...nth(1), // addr
    ...i32.load(0),
  ]),

  // ( a -- )
  drop: drop(1),

  // ( a b -- a b a )
  over: pushSp(nth(2)),

  if: [
    ...nth(1),
    ...drop(1),
    ...wasm.ifEmpty,
  ],
  else: wasm.else,
  then: wasm.endBlock,
}

function buildBinaryModule(funcs) {
    // sort funcs by index
  const sortedFuncs = Object.entries(funcs)
    .sort(([,a], [,b]) => a.i - b.i)
    .map(([name, {code}]) => ({name, code}));

  // magic number + version
  const header = [
    0x00, 0x61, 0x73, 0x6D, // magic
    0x01, 0x00, 0x00, 0x00  // version
  ];

  const sections = []
  // type section (all funcs are () -> ())
  sections.push([
    0x01, // section code
    0x00, // section size
    0x01, // num types
    0x60, // func
    0x00, // num params
    0x00  // num results
  ]);

  // import section (memory)
  sections.push([
    0x02, // section code
    0x00, // section size
    0x01, // num imports
    0x02, // mod name len
    0x6A, 0x73, // "js"
    0x03, // name len
    0x6D, 0x65, 0x6D, // "mem"
    0x02, // import kind (memory)
    0x00, 0x01 // min pages = 1
  ]);

  // function section
  const numFuncs = sortedFuncs.length;
  sections.push([
    0x03, // section code
    0x00, // size
    numFuncs, // num functions
    ...Array(numFuncs).fill(0x00) // all funcs use type 0
  ])

  // export section
  sections.push([
    0x07, // section code
    0, // section size
    numFuncs, // num exports
    ...sortedFuncs.flatMap(({name}, i) => [
      name.length, // name length
      ...Array.from(name).map(c => c.charCodeAt(0)), // name
      0x00, // export kind (func)
      i // func index
    ])
  ])

  // code section with proper function body sizes
  sections.push([
    0x0A, // section id
    0, // size
    numFuncs, // count
    ...sortedFuncs.flatMap(f => [
      ...leb128(f.code.length + 2), // size prefix for each function
      0,
      ...f.code,
      0x0b
    ])
  ])
  for (const sec of sections) {
    const count = leb128(sec.length - 2)
    sec.splice(1, 1, ...count)
  }

  // full module
  return new Uint8Array([
    ...header,
    ...sections.flat()
  ]);
}

// Returns instance
async function compileDefs(defs, mem) {
  const funcs = {}
  let i = 0
  for (const [name, def] of Object.entries(defs)) {
    if (!def.words) continue

    const code = []
    for (const word of def.words) {
      if (typeof word === 'number') {
        // push n to stack
        code.push(...pushSp(i32.const(word),))
      } else {
        if (prims[word]) {
          // Inline prims
          code.push(...prims[word])
        } else {
          // TODO could inline small words
          const wordDef = defs[word]
          if (wordDef.variable !== undefined) {
            const n = varAddr(wordDef.variable)
            code.push(...pushSp(i32.const(n)))
          } else {
            code.push(...wasm.call(funcs[word].i))
          }
        }
      }
    }
    funcs[name] = {
      i: i++,
      code
    }
  }
  const binary = buildBinaryModule(funcs)
  fs.writeFileSync('mod.wasm', binary)
  const imports = { js: { mem } };
  return await WebAssembly.instantiate(binary, imports);
}

function initSp(memory) {
  const view = new Int32Array(memory.buffer)
  view[SP_ADDR/4] = STACK_START
}

function pushInt(memory, n) {
  const view = new Int32Array(memory.buffer)
  const sp = view[SP_ADDR/4]  // divide by 4 bc Int32Array
  view[SP_ADDR/4] = sp - 4
  view[sp/4] = n
}
function popInt(memory) {
  const view = new Int32Array(memory.buffer)
  const sp = view[SP_ADDR/4] + 4
  const val = view[sp/4]
  view[SP_ADDR/4] = sp
  return val
}

const definitionKeyword = {
  ':': true,
  'variable': true,
  'constant': true
}

// Turn forth source into webassembly wat
async function runForth(source) {
  const tokens = source.split(/\s+/)
  const defs = {}
  let curDef
  let doesDef
  let lastDef
  let topLevelId = 0
  let doesId = 0
  let wasmInstance
  const memory = new WebAssembly.Memory({
    initial: 100,
    maximum: 100
  })
  initSp(memory)
  let variableN = 0
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]
    if (!tok) {
      continue
    }
    if (definitionKeyword[tok] && curDef?.topLevel) {
      wasmInstance = await compileDefs(defs, memory)
      wasmInstance.instance.exports[curDef.name]()
      curDef = null
    }
    if (tok === ':') {
      if (curDef) {
        throw new Error('cant start definition inside definition')
      }
      const name = tokens[++i];
      curDef = defs[name] = {
        name,
        words: [],
        immediate: false
      }
    } else if (tok === 'does>') {
      if (doesDef) {
        throw new Error('Repeated does>')
      }
      const name = ` _does${doesId}`
      doesDef = defs[name] = {
        name,
        words: [],
        doesId
      }
      doesId++
    } else if (tok === ';') {
      if (!doesDef && (!curDef || curDef.topLevel)) {
        throw new Error('unexpected ;')
      }
      if (doesDef) {
        // Gonna assume we are following a CREATE
        curDef.words.push(
          doesDef.doesId,
          ' _attach_does'
        )
        doesDef = null
      }
      lastDef = curDef
      curDef = null
    } else if (tok === 'variable') {
      const name = tokens[++i];
      defs[name] = {
        variable: variableN++
      }
    } else if (tok === 'constant') {
      const n = popInt(memory)
      const name = tokens[++i];
      defs[name] = {
        constant: n
      }
    } else if (tok === 'immediate') {
      if (!lastDef || curDef) {
        throw new Error('Unexpected use of immediate')
      }
      lastDef.immediate = true
    } else {
      if (!curDef) {
        const name = ` _${topLevelId++}`
        curDef = defs[name] = {
          name,
          words: [],
          topLevel: true,
          immediate: false
        }
      }
      if (tok.match(/^-?\d+$/)) {
        const n = parseInt(tok)
        curDef.words.push(n)
      } else {
        const wordDef = defs[tok] ?? prims[tok]
        if (!wordDef) {
          throw new Error('unknown word ' + tok)
        }
        if (wordDef.immediate) {
          // eval this word
          if (!wasmInstance?.exports?.[tok]) {
            // Need to compile
            wasmInstance = await compileDefs(defs, memory)
          }
          wasmInstance.instance.exports[tok]()
        } else if (wordDef.constant !== undefined) {
          curDef.words.push(wordDef.constant)
        } else {
          curDef.words.push(tok)
        }
      }
    }
  }
  if (curDef?.topLevel) {
    wasmInstance = await compileDefs(defs, memory)
    wasmInstance.instance.exports[curDef.name]()
  }
  return {
    memory,
    exports: wasmInstance?.instance.exports
  }
}

module.exports = {
  runForth,
  popInt,
  STACK_START
}
