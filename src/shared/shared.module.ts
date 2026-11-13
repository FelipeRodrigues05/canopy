import { Global, Module } from '@nestjs/common';
import { Clock, SystemClock } from './application/clock';
import { IdGenerator } from './application/id-generator';
import { UnitOfWork } from './application/unit-of-work';
import { MikroOrmUnitOfWork } from './infrastructure/persistence/mikro-orm.unit-of-work';
import { UuidV7IdGenerator } from './infrastructure/uuidv7.id-generator';

@Global()
@Module({
  providers: [
    { provide: Clock, useClass: SystemClock },
    { provide: IdGenerator, useClass: UuidV7IdGenerator },
    { provide: UnitOfWork, useClass: MikroOrmUnitOfWork },
  ],
  exports: [Clock, IdGenerator, UnitOfWork],
})
export class SharedModule {}
