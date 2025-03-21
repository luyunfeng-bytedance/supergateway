#!/usr/bin/env node
/**
 * index.ts
 *
 * Run MCP stdio servers over SSE and SSE over stdio.
 *
 * Usage:
 *   # stdio -> SSE
 *   npx -y supergateway --stdio "npx -y @modelcontextprotocol/server-filesystem /some/folder" \
 *                       --port 8000 --baseUrl http://localhost:8000 --ssePath /sse --messagePath /message
 *
 *   # SSE -> stdio
 *   npx -y supergateway --sse "https://mcp-server-ab71a6b2-cd55-49d0-adba-562bc85956e3.supermachine.app"
 */

import express from 'express'
import bodyParser from 'body-parser'
import cors from 'cors'
import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import { z } from 'zod'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { JSONRPCMessage, JSONRPCRequest } from '@modelcontextprotocol/sdk/types.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'
import { readFileSync } from 'fs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

function getVersion(): string {
  try {
    const packageJsonPath = join(__dirname, '../package.json')
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'))
    return packageJson.version || '1.0.0'
  } catch (err) {
    console.error('[supergateway]', 'Unable to retrieve version:', err)
    return 'unknown'
  }
}

const log = (...args: any[]) => console.log('[supergateway]', ...args)
const logStderr = (...args: any[]) => console.error('[supergateway]', ...args)

interface Logger {
  info: (...args: any[]) => void
  error: (...args: any[]) => void
}

const noneLogger: Logger = {
  info: () => {},
  error: () => {}
}

interface StdioToSseArgs {
  stdioCmd: string
  port: number
  baseUrl: string
  ssePath: string
  messagePath: string
  logger: Logger
  enableCors: boolean
  healthEndpoints: string[]
}

const onSignals = ({ logger }: { logger: Logger }) => {
  process.on('SIGINT', () => {
    logger.info('Caught SIGINT. Exiting...')
    process.exit(0)
  })

  process.on('SIGTERM', () => {
    logger.info('Caught SIGTERM. Exiting...')
    process.exit(0)
  })

  process.on('SIGHUP', () => {
    logger.info('Caught SIGHUP. Exiting...');
    process.exit(0);
  })

  process.stdin.on('close', () => {
    logger.info('stdin closed. Exiting...');
    process.exit(0)
  })
}

async function stdioToSse(args: StdioToSseArgs) {
  const {
    stdioCmd,
    port,
    baseUrl,
    ssePath,
    messagePath,
    logger,
    enableCors,
    healthEndpoints
  } = args

  logger.info('Starting...')
  logger.info('Supergateway is supported by Superinterface - https://superinterface.ai')
  logger.info(`  - port: ${port}`)
  logger.info(`  - stdio: ${stdioCmd}`)
  if (baseUrl) {
    logger.info(`  - baseUrl: ${baseUrl}`)
  }
  logger.info(`  - ssePath: ${ssePath}`)
  logger.info(`  - messagePath: ${messagePath}`)

  logger.info(`  - CORS enabled: ${enableCors}`)
  logger.info(`  - Health endpoints: ${healthEndpoints.length ? healthEndpoints.join(', ') : '(none)'}`)

  onSignals({ logger })

  const child: ChildProcessWithoutNullStreams = spawn(stdioCmd, { shell: true })
  child.on('exit', (code, signal) => {
    logger.error(`Child exited: code=${code}, signal=${signal}`)
    process.exit(code ?? 1)
  })

  const server = new Server(
      { name: 'supergateway', version: getVersion() },
      { capabilities: {} }
  )

  const sessions: Record<string, { transport: SSEServerTransport; response: express.Response, isProcessing: boolean}> = {}

  const app = express()

  if (enableCors) {
    app.use(cors())
  }

  app.use((req, res, next) => {
    if (req.path === messagePath) return next()
    return bodyParser.json()(req, res, next)
  })

  for (const ep of healthEndpoints) {
    app.get(ep, (_req, res) => {
      res.send('ok')
    })
  }

  app.get(ssePath, async (req, res) => {
    logger.info(`New SSE connection from ${req.ip}`)

    const sseTransport = new SSEServerTransport(`${baseUrl}${messagePath}`, res)
    await server.connect(sseTransport)

    const sessionId = sseTransport.sessionId
    if (sessionId) {
      sessions[sessionId] = { transport: sseTransport, response: res, isProcessing:false }
    }

    sseTransport.onmessage = (msg: JSONRPCMessage) => {
      logger.info(`SSE → Child (session ${sessionId}): ${JSON.stringify(msg)}`)
      child.stdin.write(JSON.stringify(msg) + '\n')
    }

    sseTransport.onclose = () => {
      logger.info(`SSE connection closed (session ${sessionId})`)
      delete sessions[sessionId]
    }

    sseTransport.onerror = err => {
      logger.error(`SSE error (session ${sessionId}):`, err)
      delete sessions[sessionId]
    }

    req.on('close', () => {
      logger.info(`Client disconnected (session ${sessionId})`)
      delete sessions[sessionId]
    })
  })

  const canIn = function f() {
    for (const [sid, session] of Object.entries(sessions)) {
      if (session.isProcessing) {
        return false
      }
    }
    return true
  }
  // @ts-ignore
  app.post(messagePath, async (req, res) => {
    const sessionId = req.query.sessionId as string
    if (!sessionId) {
      return res.status(400).send('Missing sessionId parameter')
    }

    const session = sessions[sessionId]
    if (session?.transport?.handlePostMessage) {
      logger.info(`POST to SSE transport (session ${sessionId})`)

      while(true){
        if (canIn()){
          session.isProcessing = true
          break
        }
        await sleep(10);
      }

      await session.transport.handlePostMessage(req, res)
    } else {
      res.status(503).send(`No active SSE connection for session ${sessionId}`)
    }
  })

  app.listen(port, () => {
    logger.info(`Listening on port ${port}`)
    logger.info(`SSE endpoint: http://localhost:${port}${ssePath}`)
    logger.info(`POST messages: http://localhost:${port}${messagePath}`)
  })

  let buffer = ''
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    lines.forEach(line => {
      if (!line.trim()) return
      try {
        const jsonMsg = JSON.parse(line)
        logger.info('Child → SSE:', jsonMsg)
        for (const [sid, session] of Object.entries(sessions)) {
          if (!session.isProcessing){
            continue
          }
          try {
            session.transport.send(jsonMsg)
            session.isProcessing=false
          } catch (err) {
            logger.error(`Failed to send to session ${sid}:`, err)
            delete sessions[sid]
          }
        }
      } catch {
        logger.error(`Child non-JSON: ${line}`)
      }
    })
  })

  child.stderr.on('data', (chunk: Buffer) => {
    logger.error(`Child stderr: ${chunk.toString('utf8')}`)
  })
}

interface SseToStdioArgs {
  sseUrl: string
  logger: Logger
}

async function sseToStdio(args: SseToStdioArgs) {
  const { sseUrl, logger } = args

  logger.info('Starting...')
  logger.info('Supergateway is supported by Superinterface - https://superinterface.ai')
  logger.info(`  - sse: ${sseUrl}`)
  logger.info('Connecting to SSE...')

  onSignals({ logger })

  const sseTransport = new SSEClientTransport(new URL(sseUrl))
  const sseClient = new Client(
      { name: 'supergateway', version: getVersion() },
      { capabilities: {} }
  )

  sseTransport.onerror = err => {
    logger.error('SSE error:', err)
  }
  sseTransport.onclose = () => {
    logger.error('SSE connection closed')
    process.exit(1)
  }

  await sseClient.connect(sseTransport)
  logger.info('SSE connected')

  const stdioServer = new Server(
      sseClient.getServerVersion() ?? { name: 'supergateway', version: getVersion() },
      { capabilities: sseClient.getServerCapabilities() }
  )
  const stdioTransport = new StdioServerTransport()
  await stdioServer.connect(stdioTransport)

  const wrapResponse = (req: JSONRPCRequest, payload: object) => ({
    jsonrpc: req.jsonrpc || '2.0',
    id: req.id,
    ...payload,
  })

  stdioServer.transport!.onmessage = async (message: JSONRPCMessage) => {
    const isRequest = 'method' in message && 'id' in message
    if (isRequest) {
      logger.info('Stdio → SSE:', message)
      const req = message as JSONRPCRequest
      let result
      try {
        result = await sseClient.request(req, z.any())
      } catch (err) {
        logger.error('Request error:', err)
        const errorCode =
            err && typeof err === 'object' && 'code' in err
                ? (err as any).code
                : -32000
        let errorMsg =
            err && typeof err === 'object' && 'message' in err
                ? (err as any).message
                : 'Internal error'
        const prefix = `MCP error ${errorCode}:`
        if (errorMsg.startsWith(prefix)) {
          errorMsg = errorMsg.slice(prefix.length).trim()
        }
        const errorResp = wrapResponse(req, {
          error: {
            code: errorCode,
            message: errorMsg,
          },
        })
        process.stdout.write(JSON.stringify(errorResp) + '\n')
        return
      }
      const response = wrapResponse(
          req,
          result.hasOwnProperty('error')
              ? { error: { ...result.error } }
              : { result: { ...result } }
      )
      logger.info('Response:', response)
      process.stdout.write(JSON.stringify(response) + '\n')
    } else {
      logger.info('SSE → Stdio:', message)
      process.stdout.write(JSON.stringify(message) + '\n')
    }
  }

  logger.info('Stdio server listening')
}

async function main() {
  const argv = yargs(hideBin(process.argv))
      .option('stdio', {
        type: 'string',
        description: 'Command to run an MCP server over Stdio'
      })
      .option('sse', {
        type: 'string',
        description: 'SSE URL to connect to'
      })
      .option('port', {
        type: 'number',
        default: 8000,
        description: '(stdio→SSE) Port to run on'
      })
      .option('baseUrl', {
        type: 'string',
        default: '',
        description: '(stdio→SSE) Base URL for SSE clients'
      })
      .option('ssePath', {
        type: 'string',
        default: '/sse',
        description: '(stdio→SSE) Path for SSE subscriptions'
      })
      .option('messagePath', {
        type: 'string',
        default: '/message',
        description: '(stdio→SSE) Path for SSE messages'
      })
      .option('logLevel', {
        choices: ['info', 'none'] as const,
        default: 'info',
        description: 'Set logging level: "info" or "none"'
      })
      .option('cors', {
        type: 'boolean',
        default: false,
        description: 'Enable CORS'
      })
      .option('healthEndpoint', {
        type: 'array',
        default: [],
        description: 'One or more endpoints returning "ok", e.g. --healthEndpoint /healthz --healthEndpoint /readyz'
      })
      .help()
      .parseSync()

  const hasStdio = Boolean(argv.stdio)
  const hasSse = Boolean(argv.sse)

  if (hasStdio && hasSse) {
    logStderr('Error: Specify only one of --stdio or --sse, not both')
    process.exit(1)
  } else if (!hasStdio && !hasSse) {
    logStderr('Error: You must specify one of --stdio or --sse')
    process.exit(1)
  }

  try {
    if (hasStdio) {
      await stdioToSse({
        stdioCmd: argv.stdio!,
        port: argv.port,
        baseUrl: argv.baseUrl,
        ssePath: argv.ssePath,
        messagePath: argv.messagePath,
        logger: argv.logLevel === 'none'
            ? noneLogger
            : { info: log, error: logStderr },
        enableCors: argv.cors,
        healthEndpoints: argv.healthEndpoint as string[]
      })
    } else {
      await sseToStdio({
        sseUrl: argv.sse!,
        logger: argv.logLevel === 'none'
            ? noneLogger
            : { info: logStderr, error: logStderr }
      })
    }
  } catch (err) {
    logStderr('Fatal error:', err)
    process.exit(1)
  }
}

main()

function sleep(ms:number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}