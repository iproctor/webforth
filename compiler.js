const leb = require('leb128')
const fs = require('fs')
const runtime = fs.readFileSync('runtime.4th')

const INLINE_THRESH = 15

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
  call_indirect: [0x11, 0x00, 0x00],
  ifEmpty: [0x04, 0x40], // if with empty block
  else: [0x05],
  endBlock: [0x0b],
  local_get: [0x20, 0x00],
  local_set: [0x21, 0x00],
  global_get: n => [0x23, ...leb128(n)],
  global_set: n => [0x24, ...leb128(n)],
}

const STACK_SIZE = 1024
const RSTACK_SIZE = 256
const DICT_START = STACK_SIZE + RSTACK_SIZE + 4

const RSTACK_START = STACK_SIZE + RSTACK_SIZE

const STACK_START = STACK_SIZE

function stackOps(globalIdx) {
  const readSp = wasm.global_get(globalIdx)
  const derefSp = offset => [
    ...readSp,
    ...i32.load(offset)
  ]
  const nth = n => derefSp(n * 4)
  const derefWriteSp = (offset) => [
    ...wasm.local_set, // store v
    ...readSp,
    ...wasm.local_get, // push v
    ...i32.store(offset)
  ]
  const writeNth = n => derefWriteSp(n * 4)

  const setSp = wasm.global_set(globalIdx)

  // Positive means deeper into the stack
  const moveSp = offset => [
    ...readSp,
    ...i32.const(offset),
    ...i32.add,
    ...setSp
  ]
  const drop = n => moveSp(n * 4)
  const pushSp = [
    ...writeNth(0),
    ...moveSp(-4),
  ]
  const popSp = [
    ...nth(1),
    ...moveSp(4),
  ]
  const irPush = {ir: 'push', stack: globalIdx}
  const irPop = {ir: 'pop', stack: globalIdx}
  return {
    readSp,
    derefSp,
    nth,
    derefWriteSp,
    writeNth,
    setSp,
    moveSp,
    drop,
    pushSp,
    popSp,
    irPush,
    irPop
  }
}
const stack = stackOps(0)
const rStack = stackOps(1)
function binPrim(op) {
  return [
    stack.irPop,
    ...wasm.local_set,
    stack.irPop,
    ...wasm.local_get,
    ...op,
    stack.irPush
  ]
  return [
    ...stack.nth(2),
    ...stack.nth(1),
    ...op,
    ...stack.writeNth(2),
    ...stack.drop(1),
  ]
}
function unPrim(op) {
  return [
    stack.irPop,
    ...op,
    stack.irPush
  ]
  return [
    ...stack.nth(1),
    ...op,
    ...stack.writeNth(1)
  ]
}

const runtimeImports = [
  { module: 'js', name: 'mem', desc: [0x02, 0x00, 0x01]},
  { module: 'js', name: '_writeStreamWord', desc: [0x00, 0x00]},
  { module: 'js', name: '.', desc: [0x00, 0x00]},
  { module: 'js', name: 'postpone', desc: [0x00, 0x01]}, // i32 -> ()
  { module: 'js', name: 'compile,', desc: [0x00, 0x00]},
  { module: 'js', name: "'", desc: [0x00, 0x00]},
]
const importFunctions = runtimeImports.filter(m => m.desc[0] === 0)
const nImportFunctions = importFunctions.length

const primOps = {
  // ( n -- )
  dup: [
    ...stack.nth(1),
    stack.irPush
  ],

  // ( a b -- b a )
  swap: [
    ...stack.readSp,
    ...stack.nth(1),
    ...stack.readSp,
    ...stack.nth(2),
    ...i32.store(4),
    ...i32.store(8),
  ],

  // ( a b c -- b c a )
  rot: [
    ...stack.readSp,
    ...stack.nth(1), // c
    ...stack.readSp,
    ...stack.nth(2), // b
    ...stack.readSp,
    ...stack.nth(3), /// a
    ...i32.store(4),
    ...i32.store(12),
    ...i32.store(8),
  ],
  // ( a b c -- c a b )
  '-rot': [
    ...stack.readSp,
    ...stack.nth(1), // c
    ...stack.readSp,
    ...stack.nth(2), // b
    ...stack.readSp,
    ...stack.nth(3), /// a
    ...i32.store(8),
    ...i32.store(4),
    ...i32.store(12),
  ],


  '>r': [
    stack.irPop,
    rStack.irPush
  ],
  'r>': [
    rStack.irPop,
    stack.irPush
  ],
  '2r>': [
    ...stack.moveSp(-8),
    ...rStack.nth(2),
    ...stack.writeNth(2),
    ...rStack.nth(1),
    ...stack.writeNth(1),
    ...rStack.moveSp(8),
  ],
  '2>r': [
    ...rStack.moveSp(-8),
    ...stack.nth(2),
    ...rStack.writeNth(2),
    ...stack.nth(1),
    ...rStack.writeNth(1),
    ...stack.moveSp(8),
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
    ...stack.nth(1), // addr
    ...stack.nth(2), // val
    ...i32.store(0), // lets assume we are using real memory addresses without VAR offset
    ...stack.drop(2)
  ],

  '@': [
    ...stack.nth(1), // addr
    ...i32.load(0),
    ...stack.writeNth(1),
  ],

  // ( a -- )
  drop: stack.drop(1),

  // ( a b -- a b a )
  over: [
    ...stack.nth(2),
    stack.irPush,
  ],

  execute: [
    stack.irPop,
    ...wasm.call_indirect
  ]
}
const primFuncs = {}
{
  let pk = nImportFunctions
  for (const k in primOps) {
    primFuncs[k] = {
      name: k,
      fnId: pk++,
      code: optimize([...primOps[k]])
    }
  }
}
const prims = {
  ...primOps,
  if: [
    ...stack.nth(1),
    ...stack.drop(1),
    ...wasm.ifEmpty,
  ],
  else: wasm.else,
  then: wasm.endBlock,
  dict_start: [
    ...i32.const(DICT_START),
    stack.irPush
  ]
}
const importToIndex = {}
{
  let i = 0
  for (const f of importFunctions) {
    importToIndex[f.name] = i
    prims[f.name] = wasm.call(i)
    i++
  }
}

function strBytes(str) {
  return [
    ...leb128(str.length),
    ...Buffer.from(str, 'utf-8')
  ]
}

function printMem(m) {
  const buf = new Int32Array(m.buffer)
  for (let i = 0; i < 10; i++) {
    console.log(i, buf[STACK_START/4 - i].toString(16))
  }
}

function pushInt(exports, memory, n) {
  const view = new Int32Array(memory.buffer)
  const sp = exports.sp.value
  exports.sp.value = sp - 4
  view[sp/4] = n
}
function popInt(exports, memory) {
  const view = new Int32Array(memory.buffer)
  const sp = exports.sp.value + 4
  const val = view[sp/4]
  exports.sp.value = sp
  return val
}

function buildBinaryModule(funcs) {
    // sort funcs by index
  const sortedFuncs = Object.values(funcs).sort((a, b) => a.fnId < b.fnId ? -1 : 1)

  // magic number + version
  const header = [
    0x00, 0x61, 0x73, 0x6D, // magic
    0x01, 0x00, 0x00, 0x00  // version
  ];

  const sections = []
  // type section
  sections.push([
    0x01, // section code
    0x00, // section size
    0x02, // num types
    0x60, // func () -> ()
    0x00, // num params
    0x00, // num results
    0x60, // func i32 -> ()
    0x01, // num params
    0x7F, // i32
    0x00  // num results
  ]);

  // import section (memory)
  sections.push([
    0x02, // section code
    0x00, // section size
    ...leb128(runtimeImports.length),
    ...runtimeImports.flatMap(imp => [
      ...strBytes(imp.module),
      ...strBytes(imp.name),
      ...imp.desc
    ])
  ]);

  // function section
  const numFuncs = sortedFuncs.length;
  sections.push([
    0x03, // section code
    0x00, // size
    numFuncs, // num functions
    ...Array(numFuncs).fill(0x00) // all funcs use type 0
  ])

  // table section
  sections.push([
    0x04,
    0x00,
    0x01, // 1 table
    0x70, // funcref
    0x01, // has max
    ...leb128(numFuncs),
    ...leb128(numFuncs),
  ])

  // globals
  sections.push([
    0x06,
    0x00,
    0x02,
    0x7F, 0x01, ...i32.const(STACK_START), 0x0B, // sp
    0x7F, 0x01, ...i32.const(RSTACK_START), 0x0B, // rsp
  ])

  // export section
  sections.push([
    0x07, // section code
    0, // section size
    ...leb128(numFuncs + 2), // num exports
    ...sortedFuncs.flatMap(({name, fnId}) => [
      name.length, // name length
      ...Buffer.from(name), // name
      0x00, // export kind (func)
      ...leb128(fnId) // func index
    ]),
    0x02, ...Buffer.from('sp'), 0x03, 0x00,
    0x03, ...Buffer.from('rsp'), 0x03, 0x01,
  ])

  // element
  sections.push([
    0x09,
    0,
    1, // 1 segment
    0, // active default table
    ...i32.const(0), 0x0B, // put fn at 0
    ...leb128(numFuncs), // n funcs
    ...sortedFuncs.flatMap(({fnId}) => [...leb128(fnId)])
  ])

  // code section with proper function body sizes
  sections.push([
    0x0A, // section id
    0, // size
    numFuncs, // count
    ...sortedFuncs.flatMap(f => [
      ...leb128(f.code.length + 2 + 2), // size prefix for each function
      1, 1, 0x7F,
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

function isPushPopPair(i1, i2) {
  if (typeof i1 !== 'object' || typeof i2 !== 'object') {
    return
  }
  return i1.ir === 'push' && i2.ir === 'pop' && i1.stack === i2.stack
}

function optimize(code) {
  let i = 0
  while (i < code.length) {
    const cur = code[i]
    const next = code[i+1]
    // TODO pop op push -> read op set
    if (isPushPopPair(cur, next)) {
      code.splice(i, 2)
    } else if (typeof cur === 'object') {
      if (cur.ir === 'pop') {
        code.splice(i, 1, ...stackOps(cur.stack).popSp)
      } else if (cur.ir === 'push') {
        code.splice(i, 1, ...stackOps(cur.stack).pushSp)
      }
    } else {
      i++
    }
  }
  return code
}

// Returns instance
async function compileDefs({defs, mem, tokStream, postpone, compileXt, quoteXt}) {
  const funcs = {
    ...primFuncs
  }
  for (const [name, def] of Object.entries(defs)) {
    if (!def.words) continue

    const code = []
    for (const word of def.words) {
      if (typeof word === 'number') {
        // push n to stack
        code.push(
          ...i32.const(word),
          stack.irPush
        )
      } else if (typeof word === 'object') {
        if (word.postpone) {
          const def = funcs[word.postpone]
          code.push(
            ...i32.const(def.fnId),
            ...wasm.call(importToIndex.postpone)
          )
        }
      } else {
        if (prims[word]) {
          // Inline prims
          code.push(...prims[word])
        } else if (importToIndex[word] !== undefined) {
          code.push(...wasm.call(importToIndex[word]))
        } else {
          // TODO could inline small words
          const wordDef = defs[word]
          if (funcs[word].code.length < INLINE_THRESH) {
            code.push(...i32.const(n), stack.irPush)
          } else {
            code.push(...wasm.call(funcs[word].fnId))
          }
        }
      }
    }
    optimize(code)
    funcs[name] = {
      name,
      fnId: def.fnId,
      code
    }
  }
  const binary = buildBinaryModule(funcs)
  fs.writeFileSync('mod.wasm', binary)
  let inst
  const _writeStreamWord = () => {
    const str = Buffer.from(tokStream.next(), 'utf-8')
    const memAddr = popInt(inst.instance.exports, mem)
    const view32 = new Int32Array(mem.buffer)
    view32[memAddr/4] = str.length
    const view8 = new Uint8Array(mem.buffer)
    for (let i = 0; i < str.length; i++) {
      view8[memAddr + 4 + i] = str[i]
    }
    pushInt(inst.instance.exports, mem, 4 + str.length)
  }
  const dot = () => {
    //const n = popInt(inst.instance.exports, mem)
    const stackPos = (STACK_START - inst.instance.exports.sp.value)/4
    console.log('stackp', stackPos)
    printMem(mem)
    //console.log(`dot: ${n} sp: ${stackPos}`)
  }
  const postponeWrapper = n => {
    postpone(n)
  }
  const compileXtWrapper = () => {
    compileXt(popInt(inst.instance.exports, mem))
  }
  const imports = { js: {
    mem,
    _writeStreamWord,
    '.': dot,
    postpone: postponeWrapper,
    'compile,': compileXtWrapper,
    "'": quoteXt
  } };
  inst = await WebAssembly.instantiate(binary, imports);
  return inst
}

const definitionKeyword = {
  ':': true,
  'constant': true
}

function tokenStream(tokens) {
  let i = 0
  return {
    eof: () => i === tokens.length,
    next: () => tokens[i++]
  }
}

function dictDataAddrLookup(mem, label) {
  const buf = new Int32Array(mem.buffer)
  const buf8 = new Uint8Array(mem.buffer)
  const currentDict = buf[DICT_START/4]
  if (currentDict === 0) {
    return {}
  }
  let entry = DICT_START + 4
  while (entry <= currentDict) {
    const labelLen = buf[entry/4 + 2]
    const entryLabel = Buffer.from(buf8.slice(entry + 12, entry + 12 + labelLen)).toString('utf-8')
    if (entryLabel === label) {
      const labelAlign4 = Math.ceil(labelLen/4)
      return {
        addr: entry + 12 + labelAlign4*4,
        doesId: buf[entry/4 + 1]
      }
    }
    entry += entryLen + 8
  }
  return {}
}

function xtId(def) {
  return def.fnId - nImportFunctions
}
function xtIdToFnId(xtId) {
  return xtId + nImportFunctions
}

// Turn forth source into webassembly wat
async function runForth(source) {
  const tokens = (runtime + source).split(/\s+/)
  const defs = {}
  let curDef
  let doesDef
  let lastDef
  let fnId = Object.keys(primFuncs).length + nImportFunctions
  let wasmInstance
  const createLike = new Set(['create', "'"])
  const memory = new WebAssembly.Memory({
    initial: 100,
    maximum: 100
  })
  let variableN = 0
  const tokStream = tokenStream(tokens)
  const lookupDefByFnId = id => {
    for (const k in defs) {
      if (defs[k].fnId === id) {
        return defs[k]
      }
    }
    for (const k in primFuncs) {
      if (primFuncs[k].fnId === id) {
        return primFuncs[k]
      }
    }
  }
  const compileWord = async (activeDef, name, wordDef) => {
    if (wordDef.immediate) {
      // eval this word
      if (!wasmInstance?.exports?.[name]) {
        // Need to compile
        await compile()
      }
      wasmInstance.instance.exports[name]()
    } else {
      activeDef.words.push(name)
      if (createLike.has(name)) {
        if (activeDef.topLevel) {
          // Force run toplevel
          await runTopLevel()
        } else {
          createLike.add(activeDef.name)
        }
      }
    }
  }
  const compile = async () => {
    const postpone = async fnId => {
      let activeDef = doesDef || curDef
      if (!activeDef) {
        throw new Error('postponing outside of compilation')
      }
      const fnDef = lookupDefByFnId(fnId)
      if (!fnDef) {
        throw new Error('unknown postpone fnId ' + fnId)
      }
      await compileWord(activeDef, fnDef.name, fnDef)
    }
    const compileXt = async xtId => {
      let activeDef = doesDef || curDef
      if (!activeDef) {
        throw new Error('compileXt outside of compilation')
      }
      const fnDef = lookupDefByFnId(xtIdToFnId(xtId))
      if (!fnDef) {
        throw new Error('unknown xt ' + xtId)
      }
      await compileWord(activeDef, fnDef.name, fnDef)
    }
    const quoteXt = () => {
      let activeDef = doesDef || curDef
      if (!activeDef) {
        throw new Error('compileXt outside of compilation')
      }
      const name = tokStream.next()
      const def = defs[name] ?? primFuncs[name]
      if (!def) {
        throw new Error('quote of unknown def ' + name)
      }
      pushInt(wasmInstance.instance.exports, memory, xtId(def))
    }
    let oldExports = wasmInstance?.instance.exports
    wasmInstance = await compileDefs({
      defs,
      mem: memory,
      tokStream,
      postpone,
      quoteXt,
      compileXt,
    })
    if (oldExports) {
      wasmInstance.instance.exports.sp.value = oldExports.sp.value
      wasmInstance.instance.exports.rsp.value = oldExports.rsp.value
    }
  }
  const runTopLevel = async () => {
    console.log('running topLevel', curDef.words)
    await compile()
    wasmInstance.instance.exports[curDef.name]()
    curDef = null
  }
  while (!tokStream.eof()) {
    const tok = tokStream.next()
    if (!tok) {
      continue
    }
    if (definitionKeyword[tok] && curDef?.topLevel) {
      await runTopLevel()
    }
    if (tok === ':') {
      if (curDef) {
        throw new Error('cant start definition inside definition')
      }
      const name = tokStream.next()
      curDef = defs[name] = {
        name,
        words: [],
        fnId: fnId++,
        immediate: false
      }
    } else if (tok === 'does>') {
      if (doesDef) {
        throw new Error('Repeated does>')
      }
      const name = ` _does${fnId}`
      doesDef = defs[name] = {
        name,
        words: [],
        fnId: fnId++,
        does: true
      }
    } else if (tok === ';') {
      if (!doesDef && (!curDef || curDef.topLevel)) {
        throw new Error('unexpected ;')
      }
      if (doesDef) {
        // Gonna assume we are following a CREATE
        curDef.words.push(
          doesDef.fnId,
          '_dict_current_set_does'
        )
        doesDef = null
        if (curDef.topLevel) {
          await runTopLevel()
        }
      }
      lastDef = curDef
      curDef = null
    } else if (tok === 'constant') {
      const n = popInt(wasmInstance.instance.exports, memory)
      const name = tokStream.next()
      defs[name] = {
        constant: n
      }
    } else if (tok === 'immediate') {
      if (!lastDef || curDef) {
        throw new Error('Unexpected use of immediate')
      }
      lastDef.immediate = true
    } else if (tok === 'literal') {
      const n = popInt(wasmInstance.instance.exports, memory)
      curDef.words.push(n)
    } else if (tok === 'postpone') {
      const name = tokStream.next()
      curDef.words.push({postpone: name})
    } else if (tok === ']]') {
      for (let next = tokStream.next(); next !== '[['; next = tokStream.next()) {
        curDef.words.push({postpone: next})
      }
    } else {
      let activeDef = doesDef || curDef
      if (!activeDef) {
        const name = ` _top${fnId}`
        activeDef = curDef = defs[name] = {
          name,
          words: [],
          topLevel: true,
          fnId: fnId++,
          immediate: false
        }
      }
      if (tok.match(/^-?\d+$/)) {
        const n = parseInt(tok)
        activeDef.words.push(n)
      } else {
        const wordDef = defs[tok] ?? prims[tok]
        if (!wordDef) {
          const {addr: dictAddr, doesId} = dictDataAddrLookup(memory, tok)
          if (dictAddr !== undefined) {
            activeDef.words.push(dictAddr)
            if (doesId) {
              activeDef.words.push(` _does${doesId}`)
            }
          } else {
            throw new Error('unknown word ' + tok)
          }
        } else if (wordDef.constant !== undefined) {
          activeDef.words.push(wordDef.constant)
        } else {
          await compileWord(activeDef, tok, wordDef)
        }
      }
    }
  }
  if (curDef?.topLevel) {
    await runTopLevel()
  }
  return {
    memory,
    exports: wasmInstance?.instance.exports
  }
}

module.exports = {
  runForth,
  popInt,
  STACK_START,
  DICT_START
}
