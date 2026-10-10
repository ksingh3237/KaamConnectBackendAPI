import {
  Body,
  Controller,
  Module,
  Post,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IsInt, IsString, Min } from 'class-validator';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { Public } from '../src/common/decorators/public.decorator.js';
import { configureApp } from '../src/app.setup.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

// Phase 0 e2e runs the real HTTP stack (helmet, prefix, pipe, filter, throttler) with a fake
// database, so it needs no PostgreSQL. DB-backed e2e arrives with the first model (Phase 1).
// The environment is prepared in test/setup-env.ts.

class EchoDto {
  @IsString()
  title!: string;

  @IsInt()
  @Min(1)
  fee!: number;
}

@Public()
@Controller('echo')
class EchoController {
  @Post()
  echo(@Body() dto: EchoDto) {
    return dto;
  }
}

@Module({ controllers: [EchoController] })
class EchoModule {}

describe('HTTP foundation (e2e)', () => {
  let app: INestApplication;
  let dbUp = true;

  beforeEach(async () => {
    dbUp = true;
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, EchoModule],
    })
      .overrideProvider(PrismaService)
      .useValue({
        $queryRaw: () =>
          dbUp ? Promise.resolve([1]) : Promise.reject(new Error('down')),
        $disconnect: () => Promise.resolve(),
      })
      .compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /health is unversioned and healthy', async () => {
    await request(app.getHttpServer())
      .get('/health')
      .expect(200, { status: 'ok' });
  });

  it('GET /health/ready is 200 with the database up and 503 DB_UNAVAILABLE when down', async () => {
    await request(app.getHttpServer())
      .get('/health/ready')
      .expect(200, { status: 'ok', db: 'up' });

    dbUp = false;
    const res = await request(app.getHttpServer())
      .get('/health/ready')
      .expect(503);
    expect(res.body).toMatchObject({ statusCode: 503, code: 'DB_UNAVAILABLE' });
  });

  it('serves business routes under /api/v1 only', async () => {
    await request(app.getHttpServer())
      .post('/echo')
      .send({ title: 'x', fee: 1 })
      .expect(404);
    await request(app.getHttpServer())
      .post('/api/v1/echo')
      .send({ title: 'x', fee: 1 })
      .expect(201, { title: 'x', fee: 1 });
  });

  it('answers unknown routes with the standard error body', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/nope')
      .expect(404);
    expect(res.body).toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
  });

  it('rejects invalid input with 422 VALIDATION_FAILED and field details', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/echo')
      .send({ title: 'x', fee: 0 })
      .expect(422);
    expect(res.body).toMatchObject({
      statusCode: 422,
      code: 'VALIDATION_FAILED',
    });
    expect(res.body.details).toEqual([
      {
        field: 'fee',
        issue: expect.stringContaining('must not be less than 1'),
      },
    ]);
  });

  it('rejects unknown properties (mass-assignment protection)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/echo')
      .send({ title: 'x', fee: 1, status: 'COMPLETED' })
      .expect(422);
    expect(res.body.details).toEqual([
      { field: 'status', issue: 'property status should not exist' },
    ]);
  });

  it('sets security headers and hides the framework', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('throttles to 60 requests per minute per IP, except health', async () => {
    for (let i = 0; i < 60; i += 1) {
      await request(app.getHttpServer())
        .post('/api/v1/echo')
        .send({ title: 'x', fee: 1 })
        .expect(201);
    }
    const blocked = await request(app.getHttpServer())
      .post('/api/v1/echo')
      .send({ title: 'x', fee: 1 })
      .expect(429);
    expect(blocked.body).toMatchObject({
      statusCode: 429,
      code: 'TOO_MANY_REQUESTS',
    });

    await request(app.getHttpServer()).get('/health').expect(200);
  });
});
