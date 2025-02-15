const {runForth, popInt, STACK_START} = require('./compiler')
const t = require('tap')


function printMem(m) {
  const buf = new Int32Array(m.buffer)
  console.log('sp', buf[STACK_START/4 + 1])
  for (let i = 0; i < 10; i++) {
    console.log(i, buf[STACK_START/4 - i].toString(16))
  }
}
async function test() {
  {
    const {memory: m} = await runForth('1')
    t.equal(popInt(m), 1, 'Popped 1')
  }
  {
    const {memory: m} = await runForth('1 2 3')
    t.equal(popInt(m), 3, 'Popped 3')
    t.equal(popInt(m), 2, 'Popped 2')
    t.equal(popInt(m), 1, 'Popped 1')
  }
  {
    const {memory: m} = await runForth('3 constant x x')
    t.equal(popInt(m), 3, 'Popped constant')
  }
  {
    const {memory: m, exports: e} = await runForth('1 2 +')
    t.equal(popInt(m), 3, 'Did immediate addition')
  }
  {
    const {memory: m, exports: e} = await runForth('variable x 3 x ! x @')
    t.equal(popInt(m), 3, 'Wrote and read var immediate')
  }
  {
    const {memory: m, exports: e} = await runForth('variable x : test 3 x ! x @ ; test')
    t.equal(popInt(m), 3, 'Wrote and read var compiled')
  }
  {
    const {memory: m, exports: e} = await runForth(': x 1 ; x')
    t.equal(popInt(m), 1, 'Popped 1 after call')
  }
  {
    const {memory: m, exports: e} = await runForth(': x 1 + ; 2 x')
    t.equal(popInt(m), 3, 'Did addition')
  }
}
test()
