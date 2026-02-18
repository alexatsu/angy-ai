import 'dotenv/config'
// import { serve } from '@hono/node-server'
// import { Hono } from 'hono'

// import { initAiStudio } from '@/aistudio'
import { initCommands } from '@/commands'
import 'test'

// async function main() {
//     const app = new Hono()

//     app.get('/ping', c => {
//         return c.text('pong', 200)
//     })

//     const defaultPort = 3000
//     console.log('Running server on port', defaultPort)

//     return serve({
//         fetch: app.fetch,
//         port: defaultPort,
//     })
// }

// await main()
// await initCommands()
// await initAiStudio()
