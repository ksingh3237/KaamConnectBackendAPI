import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { API_PREFIX, configureApp } from './app.setup.js';
import { AppModule } from './app.module.js';
import type { EnvVars } from './config/env.validation.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  configureApp(app);

  const config = app.get<ConfigService<EnvVars, true>>(ConfigService);
  const port = config.get('PORT', { infer: true });
  await app.listen(port);

  new Logger('Bootstrap').log(
    `KaamConnect API listening on :${port} (/${API_PREFIX}, ${config.get('NODE_ENV', { infer: true })})`,
  );
}

await bootstrap();
