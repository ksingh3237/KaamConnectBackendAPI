import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException } from '../../../common/exceptions/app.exception.js';
import { normalizePhone } from '../../../common/utils/phone.js';
import type { EnvVars } from '../../../config/env.validation.js';

/**
 * Proves that an MSG91 OTP-widget access token is genuine and says which phone number it was issued for.
 * An abstract class (not an interface) so it can be the DI token; tests replace it.
 */
export abstract class Msg91TokenVerifier {
  /** Returns the verified number as E.164 ("+919876543210"). Throws AppException when it cannot vouch for the token. */
  abstract verify(accessToken: string): Promise<string>;
}

// MSG91's server-side integration snippet for the OTP widget (the "Server-Side Integration" panel of the widget).
export const MSG91_VERIFY_ACCESS_TOKEN_URL =
  'https://control.msg91.com/api/v5/widget/verifyAccessToken';

const TIMEOUT_MS = 8000;

const invalid = () =>
  new AppException(
    'OTP_INVALID',
    401,
    'The verification is not valid or has expired. Please request a new code.',
  );
const unavailable = () =>
  new AppException(
    'OTP_PROVIDER_UNAVAILABLE',
    503,
    'The verification service is not reachable right now. Please try again.',
  );
const unexpected = () =>
  new AppException(
    'OTP_PROVIDER_ERROR',
    502,
    'The verification service gave an unexpected answer. Please try again.',
  );

/**
 * Turns MSG91's reply into a verified phone number, or an error. Fails closed: anything that is not an explicit
 * success carrying an Indian mobile number is refused. Pure, so every shape is unit-tested.
 *
 * Expected success body (reported by the widget docs and by integrators; MSG91 does not publish a schema, so the
 * first real call must be checked): `{ "type": "success", "message": "<identifier>" }` where the identifier is the
 * verified number with its country code, e.g. "919876543210".
 */
export function phoneFromVerifyResponse(
  httpStatus: number,
  body: unknown,
): string {
  if (httpStatus >= 500) throw unavailable();
  if (typeof body !== 'object' || body === null) throw unexpected();
  const { type, message } = body as { type?: unknown; message?: unknown };

  if (type !== 'success') {
    // 4xx / type "error": the token is wrong, expired, or this server's authkey is not accepted for the widget.
    throw httpStatus === 401 || httpStatus === 403 || type === 'error'
      ? invalid()
      : unexpected();
  }
  const identifier =
    typeof message === 'string' || typeof message === 'number'
      ? String(message).trim()
      : '';
  const digits = identifier.replace(/^\+/, '');
  const phone = /^\d{12}$/.test(digits)
    ? normalizePhone(`+${digits}`)
    : undefined;
  // A success with no recognisable Indian mobile number proves nothing about who this is.
  if (!phone) throw unexpected();
  return phone;
}

@Injectable()
export class Msg91HttpTokenVerifier extends Msg91TokenVerifier {
  private readonly logger = new Logger('MSG91');

  constructor(private readonly config: ConfigService<EnvVars, true>) {
    super();
  }

  async verify(accessToken: string): Promise<string> {
    const authkey = this.config.get('MSG91_AUTHKEY', { infer: true });
    if (!authkey) {
      // Config validation refuses to boot like this; kept as a second line of defence.
      throw unavailable();
    }

    let status: number;
    let body: unknown;
    try {
      const res = await fetch(MSG91_VERIFY_ACCESS_TOKEN_URL, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ authkey, 'access-token': accessToken }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      status = res.status;
      body = await res.json().catch(() => undefined);
    } catch {
      // Never log the error object: it can echo the request. Name and nothing else.
      this.logger.warn('Token verification request failed (network/timeout)');
      throw unavailable();
    }

    try {
      return phoneFromVerifyResponse(status, body);
    } catch (error) {
      // Status and MSG91's "type" only: never the token, the authkey, the number or the raw body.
      const type =
        typeof body === 'object' && body !== null
          ? String((body as { type?: unknown }).type)
          : 'none';
      this.logger.warn(
        `Token verification refused (http ${status}, type ${type})`,
      );
      throw error;
    }
  }
}
