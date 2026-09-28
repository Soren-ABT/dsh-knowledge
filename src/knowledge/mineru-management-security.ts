import type { IncomingMessage } from 'node:http'
import { DeploymentError } from './mineru-deployment-plan.js'

/** Host has no authentication middleware. Fail closed on all-interface bind,
 * reverse proxies, Electron requests without a real socket, or browser CSRF.
 * A local OS process is already inside the desktop user's trust boundary. */
export function requireLocalManagement(req: IncomingMessage, bindHost: string): void {
  const peer = req.socket?.remoteAddress
  if (bindHost !== '127.0.0.1' || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer ?? '')) {
    throw new DeploymentError('local_management_only', 'MinerU deployment management requires a loopback-bound DSH host and a local connection.', 403)
  }
  const host = req.headers.host
  if (!host || !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) throw new DeploymentError('invalid_host', 'A loopback Host header is required.', 403)
  if (req.headers['x-dsh-mineru-management'] !== '1' || req.headers['sec-fetch-site'] === 'cross-site') {
    throw new DeploymentError('management_header_required', 'Use the local DSH management panel.', 403)
  }
  const origin = req.headers.origin
  if (origin !== undefined && origin !== `http://${host}` && origin !== `https://${host}`) throw new DeploymentError('cross_origin_request', 'Cross-origin deployment management is not allowed.', 403)
  if (req.method !== 'GET' && !/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) throw new DeploymentError('invalid_content_type', 'JSON management requests are required.', 415)
}
