import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'canopy:public';

/** Opens a route without authentication (health, metrics). Everything else requires a token. */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);
