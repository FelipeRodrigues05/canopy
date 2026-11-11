import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { IdGenerator } from '../application/id-generator';

/** Time-ordered UUIDs keep primary key indexes append-mostly. */
@Injectable()
export class UuidV7IdGenerator extends IdGenerator {
  next(): string {
    return uuidv7();
  }
}
