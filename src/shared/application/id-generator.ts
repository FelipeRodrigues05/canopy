/** Identifier source port (UUIDv7 in production: time-ordered, index friendly). */
export abstract class IdGenerator {
  abstract next(): string;
}
