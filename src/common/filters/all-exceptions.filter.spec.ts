import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { vi } from 'vitest';
import { AllExceptionsFilter } from './all-exceptions.filter.js';
import { AppException } from '../exceptions/app.exception.js';

function run(exception: unknown, requestId: string | null = 'req-test-0001') {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  // A real Nest HTTP host always carries the request as well as the response.
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({ requestId: requestId ?? undefined }),
    }),
  };
  new AllExceptionsFilter().catch(exception, host as never);
  return { status: status.mock.calls[0]?.[0], body: json.mock.calls[0]?.[0] };
}

describe('AllExceptionsFilter', () => {
  it('renders AppException with its code and details', () => {
    const { status, body } = run(
      new AppException('VALIDATION_FAILED', 422, 'bad', [
        { field: 'fee', issue: 'must be > 0' },
      ]),
    );
    expect(status).toBe(422);
    expect(body).toEqual({
      statusCode: 422,
      code: 'VALIDATION_FAILED',
      message: 'bad',
      details: [{ field: 'fee', issue: 'must be > 0' }],
    });
  });

  it('omits details when there are none', () => {
    const { body } = run(
      new AppException('JOB_NOT_OPEN', 409, 'Job is no longer open'),
    );
    expect(body).not.toHaveProperty('details');
  });

  it('maps framework HttpExceptions to stable codes', () => {
    expect(run(new NotFoundException('nope')).body).toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND',
      message: 'nope',
    });
    expect(run(new BadRequestException('bad')).body).toMatchObject({
      statusCode: 400,
      code: 'BAD_REQUEST',
    });
  });

  it('maps Prisma unique-violation to 409 and missing record to 404', () => {
    const prisma = (code: string) =>
      Object.assign(new Error('db'), {
        name: 'PrismaClientKnownRequestError',
        code,
      });
    expect(run(prisma('P2002'))).toMatchObject({
      status: 409,
      body: { code: 'CONFLICT' },
    });
    expect(run(prisma('P2025'))).toMatchObject({
      status: 404,
      body: { code: 'NOT_FOUND' },
    });
  });

  it('hides internals of unexpected errors', () => {
    const { status, body } = run(new Error('password=hunter2 leaked in stack'));
    expect(status).toBe(500);
    expect(body).toEqual({
      statusCode: 500,
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong',
    });
    expect(JSON.stringify(body)).not.toContain('hunter2');
  });

  describe('what is written to the log for an unexpected error', () => {
    afterEach(() => vi.restoreAllMocks());

    it('carries the request id, so the line can be matched with the request log', () => {
      const error = vi
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      run(new Error('boom'), 'req-test-0042');
      expect(error).toHaveBeenCalledTimes(1);
      expect(String(error.mock.calls[0]![0])).toMatch(
        /^req=req-test-0042 Error: boom/,
      );
    });

    it('shows a dash when there is no request id, and stays silent for expected domain errors and 4xx', () => {
      const error = vi
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      run(new Error('boom'), null);
      expect(String(error.mock.calls[0]![0])).toMatch(/^req=- Error: boom/);
      error.mockClear();
      run(new AppException('DB_UNAVAILABLE', 503, 'down'));
      run(new NotFoundException('nope'));
      expect(error).not.toHaveBeenCalled();
    });
  });
});
