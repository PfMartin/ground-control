import { createExampleServer, DEMO_ORIGIN } from './example'

const example = createExampleServer()
example.server.on('listening', () => console.log(`Example backend listening at http://127.0.0.1:8787 (allowed origin ${DEMO_ORIGIN})`))
example.server.on('error', (error) => { console.error('Example backend failed:', error.message); process.exitCode = 1 })
