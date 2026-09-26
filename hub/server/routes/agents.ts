import type {FastifyInstance, FastifyReply, FastifyRequest} from 'fastify';
import {config} from '../config.js';
import type {Hub} from '../api.js';
import {Invalid} from '../domain/ingest.js';
import {IngestError, type Credential} from '../ingest.js';
import {Limiter, publicOrigin} from '../session.js';

/**
 * What agents talk to: the device-code flow (RFC 8628 style, JSON bodies), check-ins
 * and ingest. Agents authenticate with bearer tokens, never with cookies.
 */
export function agentRoutes(app: FastifyInstance, hub: Hub) {
  const {ingest, pairing} = hub;
  const codes = new Limiter(30, 60 * 60_000);

  /** The credential of an agent's request; null when it is refused, answered in the spec's terms. */
  const authenticated = (request: FastifyRequest, reply: FastifyReply): Credential | null => {
    const found = ingest.authenticate(request.headers.authorization);
    if (found === 'revoked') {
      void reply.code(403).send({error: 'device_revoked'});
      return null;
    }
    if (!found) void reply.code(401).send({error: 'unauthorized'});
    return found;
  };

  /**
   * Checks the token before the body is read (a route's own hooks run after the hub's
   * Host and method checks): a request without a valid one is refused at once, so whoever
   * reaches the hub cannot make it hold bodies it would throw away.
   */
  const early = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!authenticated(request, reply)) return reply;
  };

  /**
   * Runs an agent request with its credential, answering refusals in the spec's terms.
   * The token is checked again once the body is in: while it arrived, the device may have
   * been removed, or connected anew with another secret.
   */
  const asAgent = <T>(request: FastifyRequest, reply: FastifyReply, invalid: string, work: (credential: Credential) => T) => {
    const credential = authenticated(request, reply);
    if (!credential) return reply;
    try {
      return work(credential);
    } catch (error) {
      if (error instanceof IngestError) return reply.code(403).send({error: error.code});
      if (error instanceof Invalid) return reply.code(400).send({error: invalid, detail: error.what});
      throw error;
    }
  };

  // The desktop app's hub connects no other machine: its own agent has its token.
  if (!hub.local) {
    app.post('/v1/device/code', (request, reply) => {
      if (!codes.allow(request.ip)) return reply.code(429).send({error: 'too_many_attempts'});
      const started = pairing.start(request.body);
      if (!started) return reply.code(400).send({error: 'invalid_request'});
      const page = `${publicOrigin(request)}/device`;
      return {...started, verificationUri: page, verificationUriComplete: `${page}?code=${started.userCode}`};
    });

    app.post<{Body: {deviceCode?: unknown}}>('/v1/device/token', (request, reply) => {
      const result = pairing.poll(request.body?.deviceCode);
      if (typeof result === 'string') return reply.code(400).send({error: result});
      return {token: result.token, device: {id: result.device.id, name: result.device.label ?? result.device.name}, account: result.account};
    });
  }

  app.post('/v1/checkin', {onRequest: early}, (request, reply) => asAgent(request, reply, 'invalid_request', credential => ingest.checkin(credential, request.body)));

  // Up to 200 sessions with three names at their longest, in any script and escaped (spec: Reporting running agents).
  app.post('/v1/sessions', {bodyLimit: 512 * 1024, onRequest: early}, (request, reply) =>
    asAgent(request, reply, 'invalid_request', credential => ingest.sessions(credential, request.body)),
  );

  app.post('/v1/ingest', {bodyLimit: config.ingest.bodyLimit, onRequest: early}, (request, reply) =>
    asAgent(request, reply, 'invalid_batch', credential => ingest.accept(credential, request.body)),
  );
}
