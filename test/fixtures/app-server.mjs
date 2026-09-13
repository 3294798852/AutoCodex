import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
let requestId;
lines.on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') { process.stdout.write('diagnostic line\n'); send({ id: message.id, result: { userAgent: 'fixture/0.153.4' } }); }
  if (message.method === 'test/unicode') {
    const data = Buffer.from(`${JSON.stringify({ id: message.id, result: { text: '断流恢复 ✓' } })}\n`);
    const position = data.indexOf(Buffer.from('断')) + 1;
    process.stdout.write(data.subarray(0, position)); setTimeout(() => process.stdout.write(data.subarray(position)), 5);
  }
  if (message.method === 'test/error') send({ id: message.id, error: { code: -32001, message: 'Server overloaded; retry later.', data: { reason: 'busy' } } });
  if (message.method === 'test/request') { requestId = message.id; send({ id: 'server-55', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1' } }); }
  if (message.id === 'server-55' && message.result) send({ id: requestId, result: message.result });
  if (message.method === 'test/disconnect') process.exit(9);
});
