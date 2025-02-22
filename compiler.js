const leb = require('leb128')
const fs = require('fs')
const runtime = fs.readFileSync('runtime.4th')

const INLINE_THRESH = 5
const N_LOCALS = 2

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
  block: [0x02, 0x40],
  loop: [0x03, 0x40],
  endBlock: [0x0b],
  local_get: n => [0x20, ...leb128(n)],
  local_set: n => [0x21, ...leb128(n)],
  local_tee: n => [0x22, ...leb128(n)],
  global_get: n => [0x23, ...leb128(n)],
  global_set: n => [0x24, ...leb128(n)],
  br: n => [0x0C, ...leb128(n)]
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
    ...wasm.local_set(0), // store v
    ...readSp,
    ...wasm.local_get(0), // push v
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
  const pushSp = n => {
    const ret = [
      ...moveSp(n * -4)
    ]
    for (let i = 0; i < n; i++) {
      ret.push(...writeNth(i+1))
    }
    return ret
  }
  const popSp = n => {
    const ret = []
    for (let i = 0; i < n; i++) {
      ret.push(...nth(n - i))
    }
    ret.push(...moveSp(n * 4))
    return ret
  }
  const irPush = n => ({ir: 'push', stack: globalIdx, n})
  const irPop = n => ({ir: 'pop', stack: globalIdx, n})
  const mergePushPop = ({n: pushN}, {n: popN}) => {
    if (pushN === popN) {
      return []
    }
    if (pushN < popN && pushN <= N_LOCALS) {
      // More needing to be popped.
      const ret = []
      // Save pushed to locals
      for (let i = 0; i < pushN; i++) {
        ret.push(...wasm.local_set(i)) // local_set 0
      }
      // Load up bottom values into stack
      for (let i = popN - pushN; i >= 1; i--) {
        ret.push(...nth(i)) // nth(2)
      }
      // Restore top values
      for (let i = pushN - 1; i >= 0; i--) {
        ret.push(...wasm.local_get(i))
      }
      // Move stack pointer
      ret.push(...moveSp(4*(popN - pushN)))
      return ret
    }
    // Otherwise just emit the full push and the full pop
    return [
      ...pushSp(pushN),
      ...popSp(popN)
    ]
  }
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
    irPop,
    mergePushPop
  }
}
const stack = stackOps(0)
const rStack = stackOps(1)
function binPrim(op) {
  return [
    stack.irPop(2),
    ...op,
    stack.irPush(1)
  ]
}
function unPrim(op) {
  return [
    stack.irPop(1),
    ...op,
    stack.irPush(1)
  ]
}

let typeI = 0
const types = {
  void_to_void: {desc: [0x00, typeI++], pop: 0, push: 0},
  i32_to_i32: {desc: [0x00, typeI++], pop: 1, push: 1},
  i32_i32_to_void: {desc: [0x00, typeI++], pop: 2, push: 0},
  i32_to_void: {desc: [0x00, typeI++], pop: 1, push: 0},
  void_to_i32: {desc: [0x00, typeI++], pop: 0, push: 1},
}

const runtimeImports = [
  { module: 'js', name: 'mem', desc: [0x02, 0x00, 0x01]},
  { module: 'js', name: '_writeStreamWord', ...types.i32_to_i32},
  { module: 'js', name: '.', ...types.void_to_void},
  { module: 'js', name: 'postpone', ...types.i32_i32_to_void},
  { module: 'js', name: 'compile,', ...types.i32_to_void},
  { module: 'js', name: "'", ...types.void_to_i32},
  { module: 'js', name: "type", ...types.i32_i32_to_void},
]
const importFunctions = runtimeImports.filter(m => m.desc[0] === 0)
const nImportFunctions = importFunctions.length

const binOps = {
  '+': i32.add,

  // ( a b -- a-b
  '-': i32.sub,

  // ( a b -- a*b )
  '*': i32.mul,
  '=':  i32.eq,
  '<>': i32.ne,
  '<':  i32.lt_s,
  'u<': i32.lt_u,
  '>':  i32.gt_s,
  'u>': i32.gt_u,
  '<=': i32.le_s,
  'u<=':i32.le_u,
  '>=': i32.ge_s,
  'u>=':i32.ge_u,

  // bitwise ops
  'and': i32.and,
  'or':  i32.or,
  'xor': i32.xor,
  'lshift': i32.shl,
  'rshift': i32.shr_u, // forth traditionally uses unsigned
  'rotate': i32.rotl,  // might want both rotl/rotr tbh

  // division & remainder
  '/': i32.div_s,
  'u/': i32.div_u,
  'mod': i32.rem_s,
  'umod': i32.rem_u,
}

const unaryOps = {
  // bit counting (unary prims)
  'clz': i32.clz,
  'ctz': i32.ctz,
  'popcnt': i32.popcnt,
}

const pureOps = {
  dup: [[
    ...wasm.local_tee(0),
    ...wasm.local_get(0)
  ], 1, 2],
  swap: [[
    ...wasm.local_set(0),
    ...wasm.local_set(1),
    ...wasm.local_get(0),
    ...wasm.local_get(1),
  ], 2, 2],
  drop: [wasm.local_set(0), 1, 0],
  over: [[
    ...wasm.local_set(0),
    ...wasm.local_tee(1),
    ...wasm.local_get(0),
    ...wasm.local_get(1),
  ], 2, 3],
  '@': [i32.load(0), 1, 1],
}

const primFuncOps = {
  // ( n -- )
  dup: [
    ...stack.nth(1),
    stack.irPush(1)
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
    stack.irPop(1),
    rStack.irPush(1)
  ],
  'r>': [
    rStack.irPop(1),
    stack.irPush(1)
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
  rdrop: rStack.drop(1),
  rover: [
    ...rStack.nth(2),
    rStack.irPush(1),
  ],

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
    stack.irPush(1),
  ],

  execute: [
    stack.irPop(1),
    ...wasm.call_indirect
  ]
}
for (const k in binOps) {
  primFuncOps[k] = binPrim(binOps[k])
  pureOps[k] = [binOps[k], 2, 1]
}
for (const k in unaryOps) {
  primFuncOps[k] = unPrim(unaryOps[k])
  pureOps[k] = [unaryOps[k], 1, 1]
}
const controlInstructions = {
  if: [
    stack.irPop(1),
    ...wasm.ifEmpty,
  ],
  then: wasm.endBlock,
  begin: [
    ...wasm.block,
    ...wasm.loop,
  ],
  leave: wasm.br(1),
  continue: wasm.br(0),
  again: [
    ...wasm.br(0),
    ...wasm.endBlock,
    ...wasm.endBlock,
  ],
}
const primNonFuncOps = {
  if: [{ir: 'if'}],
  else: wasm.else,
  then: [{ir: 'then'}],

  begin: [{ir: 'begin'}],
  leave: [{ir: 'leave'}],
  continue: [{ir: 'continue'}],
  again: [{ir: 'again'}],
}
const primNonFuncIds = {}
{
  let id = -1
  for (const k in primNonFuncOps) {
    primNonFuncIds[k] = id--
  }
}
const importToIndex = {}
{
  let i = 0
  for (const f of importFunctions) {
    const {pop = 0, push = 0, name} = f
    importToIndex[f.name] = i
    const r = []
    if (pop > 0) {
      r.push(stack.irPop(pop))
    }
    r.push(...wasm.call(i))
    if (push > 0) {
      r.push(stack.irPush(push))
    }
    pureOps[f.name] = [wasm.call(i), pop, push]
    primFuncOps[f.name] = r
    i++
  }
}
const prims = {
  ...primFuncOps,
  ...primNonFuncOps,
  dict_start: [
    ...i32.const(DICT_START),
    stack.irPush(1)
  ],
}
const primFuncs = {}
{
  let pk = nImportFunctions
  for (const k in primFuncOps) {
    primFuncs[k] = {
      name: k,
      fnId: pk++,
      code: optimize([...primFuncOps[k]])
    }
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
    ...leb128(Object.keys(types).length), // num types
    ...Object.values(types).flatMap(type => [
      0x60,
      ...leb128(type.pop),
      ...Array(type.pop).fill(0x7F),
      ...leb128(type.push),
      ...Array(type.push).fill(0x7F),
    ])
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
      1, ...leb128(N_LOCALS), 0x7F,
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
  return i1.ir === 'push' && i2.ir === 'pop' && i1.stack === i2.stack && i2.n - i1.n <= N_LOCALS
}

function optimize(code) {
  let i = 0
  while (i < code.length) {
    const cur = code[i]
    const next = code[i+1]
    // TODO pop op push -> read op set
    if (isPushPopPair(cur, next)) {
      const transfer = stackOps(cur.stack).mergePushPop(cur, next)
      code.splice(i, 2, ...transfer)
    } else if (typeof cur === 'object') {
      if (cur.ir === 'pop') {
        code.splice(i, 1, ...stackOps(cur.stack).popSp(cur.n))
      } else if (cur.ir === 'push') {
        code.splice(i, 1, ...stackOps(cur.stack).pushSp(cur.n))
      }
    } else {
      i++
    }
  }
  return code
}

const isPure = word => typeof word === 'number' || (typeof word === 'string' && pureOps[word])
const isNumber = word => word.match(/^-?\d+$/)
const parseNumber = word => parseInt(word)

// Returns instance
async function compileDefs({defs, mem, tokStream, postpone, compileXt, quoteXt}) {
  const funcs = {
    ...primFuncs
  }
  for (const [name, def] of Object.entries(defs)) {
    if (!def.words) {
      continue
    }
    if (def.topLevel && !def.compile) {
      // Only want to compile the toplevel at the start of a new defn. Flag set earlier.
      continue
    }
    let p = () => null
    if (name== 'create') {
      //p = console.log
    }

    let code = []
    const words = [...def.words]
    for (let i = 0; i < words.length; i++) {
      let word = words[i]
      p(word)
      if (isPure(word)) {
        const pureSeq = []
        let maxStackDepth = 0
        let curStackDepth = 0

        while (true) {
          p('pure', word)
          if (typeof word === 'number') {
            pureSeq.push(...i32.const(word))
            curStackDepth--
          } else {
            const [code, popN, pushN] = pureOps[word]
            pureSeq.push(...code)
            curStackDepth += popN
            if (curStackDepth > maxStackDepth) {
              maxStackDepth = curStackDepth
            }
            curStackDepth -= pushN
          }
          i++
          word = words[i]
          if (!isPure(word)) {
            i--
            break
          }
        }
        const toCopy = maxStackDepth - curStackDepth
        if (maxStackDepth > 0) {
          p('pure pop', maxStackDepth)
          code.push(stack.irPop(maxStackDepth))
        }
        code.push(...pureSeq)
        if (toCopy > 0) {
          p('pure push', toCopy)
          code.push(stack.irPush(toCopy))
        }
      } else if (typeof word === 'object') {
        if (word.postpone) {
          let type = 0, id = 0
          if (isNumber(word.postpone)) {
            id = parseNumber(word.postpone)
          } else {
            type = 1
            id = primNonFuncIds[word.postpone] ?? funcs[word.postpone]?.fnId
            if (id === undefined) {
              throw new Error('Unknown postpone word: ' + word.postpone)
            }
          }
          code.push(
            ...i32.const(type),
            ...i32.const(id),
            ...wasm.call(importToIndex.postpone)
          )
        }
      } else {
        if (prims[word]) {
          // Inline prims
          p('prim', word)
          code.push(...prims[word])
        } else if (importToIndex[word] !== undefined) {
          p('import', word)
          code.push(...wasm.call(importToIndex[word]))
        } else {
          const wordDef = defs[word]
          if (wordDef.words.length < INLINE_THRESH) {
            p('inline', word)
            words.splice(i, 1, ...wordDef.words)
            i--
            continue
          } else {
            p('call', word)
            code.push(...wasm.call(funcs[word].fnId))
          }
        }
      }
    }
    const ifStack = [0]
    const newCode = []
    for (const inst of code) {
      if (typeof inst !== 'object') {
        newCode.push(inst)
        continue
      }
      if (inst.ir === 'if') {
        ifStack[ifStack.length - 1]++
        newCode.push(...controlInstructions.if)
      } else if (inst.ir === 'then') {
        ifStack[ifStack.length - 1]--
        newCode.push(...controlInstructions.then)
      } else if (inst.ir === 'begin') {
        ifStack.push(0)
        newCode.push(...controlInstructions.begin)
      } else if (inst.ir === 'leave') {
        newCode.push(...wasm.br(1 + ifStack[ifStack.length - 1]))
      } else if (inst.ir === 'continue') {
        newCode.push(...wasm.br(ifStack[ifStack.length - 1]))
      } else if (inst.ir === 'again') {
        ifStack.pop()
        newCode.push(...controlInstructions.again)
      } else {
        newCode.push(inst)
      }
    }
    code = newCode
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
  const _writeStreamWord = memAddr => {
    const str = Buffer.from(tokStream.next().word, 'utf-8')
    //const memAddr = popInt(inst.instance.exports, mem)
    const view32 = new Int32Array(mem.buffer)
    view32[memAddr/4] = str.length
    const view8 = new Uint8Array(mem.buffer)
    for (let i = 0; i < str.length; i++) {
      view8[memAddr + 4 + i] = str[i]
    }
    return 4 + str.length
    //pushInt(inst.instance.exports, mem, 4 + str.length)
  }
  const dot = () => {
    //const n = popInt(inst.instance.exports, mem)
    const stackPos = (STACK_START - inst.instance.exports.sp.value)/4
    console.log('stackp', stackPos)
    printMem(mem)
    //console.log(`dot: ${n} sp: ${stackPos}`)
  }
  const typeFn = (strPtr, strLen) => {
    const view8 = new Uint8Array(mem.buffer)
    const str = Buffer.from(view8.slice(strPtr, strPtr + strLen)).toString('utf-8')
    console.log(str)
  }
  const imports = { js: {
    mem,
    _writeStreamWord,
    '.': dot,
    postpone,
    'compile,': compileXt,
    "'": quoteXt,
    type: typeFn
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
    const entryLen = buf[entry/4]
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

function writeStringToDict(mem, str) {
  const buf = new Int32Array(mem.buffer)
  const buf8 = new Uint8Array(mem.buffer)
  const strBytes = Buffer.from(str, 'utf-8')
  const currentDict = buf[DICT_START/4]
  for (let i = 0; i < strBytes.length; i++) {
    buf8[currentDict + i] = strBytes[i]
  }
  buf8[currentDict + str.length] = 0
  buf[DICT_START/4] = currentDict + str.length + 1
  return currentDict
}

function xtId(def) {
  return def.fnId - nImportFunctions
}
function xtIdToFnId(xtId) {
  return xtId + nImportFunctions
}

class TokenStream {
  constructor(input) {
    this.input = input;
    this.pos = 0;
  }

  isEOF() {
    return this.pos >= this.input.length;
  }

  peek() {
    return this.pos < this.input.length ? this.input[this.pos] : null;
  }

  next() {
    // yeet whitespace
    while (this.pos < this.input.length && /\s/.test(this.peek())) {
      this.pos++;
    }

    if (this.pos >= this.input.length) return null;

    // string time
    if (this.peek() === '"') {
      return this.readString();
    }

    // word token grindset
    return this.readWord();
  }

  readString() {
    let str = '';
    this.pos++; // yeet quote

    while (this.pos < this.input.length) {
      const c = this.input[this.pos++];

      if (c === '\\') {
        if (this.pos >= this.input.length) throw new Error('no cap finish ur escape');
        const next = this.input[this.pos++];
        str += next === 'n' ? '\n' :
               next === 't' ? '\t' :
               next === 'r' ? '\r' :
               next === '"' ? '"' :
               next === '\\' ? '\\' :
               (() => { throw new Error(`fr what is \\${next}`) })();
      } else if (c === '"') {
        return { string: str };
      } else {
        str += c;
      }
    }

    throw new Error('close ur string bestie');
  }

  readWord() {
    let word = '';
    while (this.pos < this.input.length && !/[\s"]/.test(this.peek())) {
      word += this.input[this.pos++];
    }
    return word.length > 0 ? { word } : this.next();
  }
}

// Turn forth source into webassembly wat
async function runForth(source) {
  const tokens = runtime + source
  const defs = {}
  let curDef
  let doesDef
  let lastDef
  let inlineImmDef
  const getActiveDef = () => inlineImmDef || doesDef || curDef
  let fnId = Object.keys(primFuncs).length + nImportFunctions
  let wasmInstance
  const createLike = new Set(['create', "'"])
  const memory = new WebAssembly.Memory({
    initial: 100,
    maximum: 100
  })
  let variableN = 0
  const tokStream = new TokenStream(tokens)
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
      if (!wasmInstance?.instance.exports?.[name]) {
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
    const postpone = async (type, fnId) => {
      let activeDef = getActiveDef()
      if (!activeDef) {
        throw new Error('postponing outside of compilation')
      }
      let name, fnDef = {}
      if (type === 0) { // number
        name = fnId
      } else if (fnId < 0) {
        for (const k in primNonFuncIds) {
          if (primNonFuncIds[k] === fnId) {
            name = k
            break
          }
        }
      } else {
        fnDef = lookupDefByFnId(fnId)
        if (!fnDef) {
          throw new Error('unknown postpone fnId ' + fnId)
        }
        name = fnDef.name
      }
      await compileWord(activeDef, name, fnDef)
    }
    const compileXt = async xtId => {
      let activeDef = getActiveDef()
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
      let activeDef = getActiveDef()
      if (!activeDef) {
        throw new Error('compileXt outside of compilation')
      }
      const {word: name} = tokStream.next()
      if (!name) {
        throw new Error('Did not get a word after quote')
      }
      const def = defs[name] ?? primFuncs[name]
      if (!def) {
        throw new Error('quote of unknown def ' + name)
      }
      return xtId(def)
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
    curDef.compile = true
    await compile()
    wasmInstance.instance.exports[curDef.name]()
    curDef = null
  }
  while (!tokStream.isEOF()) {
    const tok = tokStream.next()
    if (!tok) {
      continue
    }
    if (definitionKeyword[tok.word] && curDef?.topLevel) {
      await runTopLevel()
    }
    if (tok.word === ':') {
      if (curDef) {
        throw new Error('cant start definition inside definition')
      }
      const {word: name} = tokStream.next()
      curDef = defs[name] = {
        name,
        words: [],
        fnId: fnId++,
        immediate: false
      }
    } else if (tok.word === 'does>') {
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
    } else if (tok.word === ';') {
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
    } else if (tok.word === 'constant') {
      const n = popInt(wasmInstance.instance.exports, memory)
      const {word: name} = tokStream.next()
      defs[name] = {
        constant: n
      }
    } else if (tok.word === 'immediate') {
      if (!lastDef || curDef) {
        throw new Error('Unexpected use of immediate')
      }
      lastDef.immediate = true
    } else if (tok.word === 'literal') {
      const n = popInt(wasmInstance.instance.exports, memory)
      curDef.words.push(n)
    } else if (tok.word === 'postpone') {
      const {word: name} = tokStream.next()
      curDef.words.push({postpone: name})
    } else if (tok.word === '[[') {
      // Start immediate mode
      const name = ` _imm${fnId}`
      inlineImmDef = defs[name] = {
        name,
        words: [],
        fnId: fnId++,
      }
    } else if (tok.word === ']]') {
      if (inlineImmDef) {
        // Closing immediate in a non immediate word
        const {name} = inlineImmDef
        inlineImmDef = null
        await compile()
        wasmInstance.instance.exports[name]()
        // Could delete this def now...
      } else {
        // Meant to be used in an immediate word
        for (let {word: next} = tokStream.next(); next !== '[['; {word: next} = tokStream.next()) {
          curDef.words.push({postpone: next})
        }
      }
    } else {
      let activeDef = getActiveDef()
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
      if (tok.string) {
        const addr = writeStringToDict(memory, tok.string)
        activeDef.words.push(addr, tok.string.length)
      } else if (isNumber(tok.word)) {
        const n = parseNumber(tok.word)
        activeDef.words.push(n)
      } else {
        const wordDef = defs[tok.word] ?? prims[tok.word]
        if (!wordDef) {
          const {addr: dictAddr, doesId} = dictDataAddrLookup(memory, tok.word)
          if (dictAddr !== undefined) {
            activeDef.words.push(dictAddr)
            if (doesId) {
              activeDef.words.push(` _does${doesId}`)
            }
          } else {
            throw new Error('unknown word ' + tok.word)
          }
        } else if (wordDef.constant !== undefined) {
          activeDef.words.push(wordDef.constant)
        } else {
          await compileWord(activeDef, tok.word, wordDef)
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
  DICT_START,
  printMem
}
