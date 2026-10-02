// Offline child-process fixture: exercise real IPC, exit, timeout and ownership.
process.on('disconnect', () => process.exit(0))
process.on('message', message => {
  if (message.modelDir === 'crash') { process.exit(86); return }
  if (message.modelDir === 'disconnect') { process.disconnect(); return }
  if (message.modelDir === 'hang') return
  process.send({
    protocolVersion: message.modelDir === 'invalid' ? 99 : 1,
    id: message.id,
    operation: 'recognize',
    ok: true,
    text: `${process.pid}:${Buffer.isBuffer(message.png) ? 'buffer' : 'other'}:${Buffer.from(message.png).toString('hex')}`,
  })
})
