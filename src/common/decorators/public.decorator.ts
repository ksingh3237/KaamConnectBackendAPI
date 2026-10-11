import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/** Opts a route out of the global JWT guard. Every route is authenticated unless marked. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
