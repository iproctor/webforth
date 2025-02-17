const {runForth, popInt, STACK_START, DICT_START, printMem} = require('./compiler')
const t = require('tap')


function parseDict(m) {
  const buf = new Int32Array(m.buffer)
  const buf8 = new Uint8Array(m.buffer)
  const currentDict = buf[DICT_START/4]
  if (currentDict === 0) {
    return []
  }
  let entry = DICT_START + 4
  //console.log('firstEntry', entry)
  //console.log('curDictPtr', currentDict)
  const entries = []
  while (entry <= currentDict) {
    const entryLen = buf[entry/4]
    const labelLen = buf[entry/4 + 2]
    const labelAlign4 = Math.ceil(labelLen/4)
    const dataLen = entryLen - 4 - labelAlign4 * 4
    const label = Buffer.from(buf8.slice(entry + 12, entry + 12 + labelLen)).toString('utf-8')
    const dataStart = entry/4 + 3 + labelAlign4
    //console.log('entry lens', {entry, entryLen, labelLen, labelAlign4, dataLen, dataStart})
    const data = buf.slice(dataStart, dataStart + dataLen/4)
    entries.push({
      len: entryLen,
      label,
      data
    })
    entry += entryLen + 8
  }
  return entries
}
async function test() {
  {
    const {memory: m, exports: e} = await runForth('1')
    t.equal(popInt(e, m), 1, 'Popped 1')
  }
  {
    const {memory: m, exports: e} = await runForth('1 2 3')
    t.equal(popInt(e, m), 3, 'Popped 3')
    t.equal(popInt(e, m), 2, 'Popped 2')
    t.equal(popInt(e, m), 1, 'Popped 1')
  }
  {
    const {memory: m, exports: e} = await runForth('1 2 swap')
    t.equal(popInt(e, m), 1, 'swap popped 1')
    t.equal(popInt(e, m), 2, 'swap popped 2')
  }
  {
    const {memory: m, exports: e} = await runForth('2 dup')
    t.equal(popInt(e, m), 2, 'dup popped 2')
    t.equal(popInt(e, m), 2, 'dup popped 2')
  }
  {
    const {memory: m, exports: e} = await runForth('1 2 drop')
    t.equal(popInt(e, m), 1, 'drop popped 1')
  }
  {
    const {memory: m, exports: e} = await runForth('1 2 3 rot')
    t.equal(popInt(e, m), 1, 'rot popped 1')
    t.equal(popInt(e, m), 3, 'rot popped 3')
    t.equal(popInt(e, m), 2, 'rot popped 2')
  }
  {
    const {memory: m, exports: e} = await runForth('1 2 3 rot +')
    t.equal(popInt(e, m), 4, 'rot + popped 4')
  }
  {
    const {memory: m, exports: e} = await runForth('3 constant x x')
    t.equal(popInt(e, m), 3, 'Popped constant')
  }
  {
    const {memory: m, exports: e} = await runForth('1 2 +')
    t.equal(popInt(e, m), 3, 'Did immediate addition')
  }
  {
    const {memory: m, exports: e} = await runForth(': x 1 ; x')
    t.equal(popInt(e, m), 1, 'Popped 1 after call')
  }
  {
    const {memory: m, exports: e} = await runForth(': x 1 + ; 2 x')
    t.equal(popInt(e, m), 3, 'Did addition')
  }
  {
    const {memory: m, exports: e} = await runForth('3 1 1 = if 2 * then')
    t.equal(popInt(e, m), 6, 'True condition for if')
  }
  {
    const {memory: m, exports: e} = await runForth('3 1 2 = if 2 * then')
    t.equal(popInt(e, m), 3, 'False condition for if')
  }
  {
    const {memory: m, exports: e} = await runForth('3 1 1 = if 2 * else 3 * then')
    t.equal(popInt(e, m), 6, 'True condition for if/else')
  }
  {
    const {memory: m, exports: e} = await runForth('3 1 2 = if 2 * else 3 * then')
    t.equal(popInt(e, m), 9, 'False condition for if/else')
  }
  {
    const {memory: m, exports: e} = await runForth('create goober')
    const entries = parseDict(m)
    t.equal(entries.length, 1, '1 entry')
    t.equal(entries[0].label, 'goober', 'create label')
  }
  {
    const {memory: m, exports: e} = await runForth('create alpha create beta')
    const entries = parseDict(m)
    //console.log(entries)
    t.equal(entries.length, 2, '2 entries')
    t.equal(entries[0].label, 'alpha', 'label 1')
    t.equal(entries[1].label, 'beta', 'label 2')
  }
  {
    const {memory: m, exports: e} = await runForth('create goober 13 , 15 , goober @ goober 4 + @')
    const entries = parseDict(m)
    t.equal(entries[0].data[0], 13, 'create value 1')
    t.equal(entries[0].data[1], 15, 'create value 2')
    t.equal(popInt(e, m), 15, 'Read from data')
    t.equal(popInt(e, m), 13, 'Read from data')
  }
  {
    const {memory: m, exports: e} = await runForth('create x 13 , does> @ 2 * ; x')
    const entries = parseDict(m)
    t.equal(popInt(e, m), 26, 'Executed does')
  }
  {
    const {memory: m, exports: e} = await runForth(': dbl_const create , does> @ 2 * ; 13 dbl_const yy yy')
    const entries = parseDict(m)
    t.equal(popInt(e, m), 26, 'Create/does within def')
  }
  {
    const {memory: m, exports: e} = await runForth('variable x 3 x ! x @')
    t.equal(popInt(e, m), 3, 'Wrote and read var top level')
  }
  {
    const {memory: m, exports: e} = await runForth('variable x : test 3 x ! x @ ; test')
    t.equal(popInt(e, m), 3, 'Wrote and read var compiled')
  }
  {
    const {memory: m, exports: e} = await runForth(': +1 1 + ; : imm+ postpone +1 ; immediate 3 imm+')
    t.equal(popInt(e, m), 4, 'immediate postpone works')
  }
  {
    const {memory: m, exports: e} = await runForth(': myIf postpone if ; immediate 1 myIf 8 then')
    t.equal(popInt(e, m), 8, 'postpone if works')
  }
  {
    const {memory: m, exports: e} = await runForth(': +1 1 + ; : imm+ ]] +1 +1 [[ ; immediate 3 imm+')
    t.equal(popInt(e, m), 5, 'immediate ]] [[ works')
  }
  {
    const {memory: m, exports: e} = await runForth("3 ' dup execute *")
    t.equal(popInt(e, m), 9, 'quote and execute works')
  }
  {
    const {memory: m, exports: e} = await runForth("3 >r 4 r> -")
    t.equal(popInt(e, m), 1, 'return stack')
  }
  {
    const {memory: m, exports: e} = await runForth("1 2 2>r 0 2r> +")
    t.equal(popInt(e, m), 3, 'return stack 2')
  }
  {
    const {memory: m, exports: e} = await runForth("1 2 3 v swap * +")
    t.equal(popInt(e, m), 5, 'v macro test')
  }
  {
    const {memory: m, exports: e} = await runForth("0 infloop 1 + dup 10 = if 0 if else break then then endinf")
    t.equal(popInt(e, m), 10, 'loop test')
  }
  {
    const {memory: m, exports: e} = await runForth("0 10 0 do 1 + loop")
    t.equal(popInt(e, m), 10, 'do loop test')
  }
}
test()
