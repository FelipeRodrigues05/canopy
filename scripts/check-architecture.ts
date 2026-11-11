/**
 * Architecture rules the linter cannot express:
 *
 * 1. domain/ is pure: no NestJS, MikroORM, AWS SDK, node:crypto, or imports of
 *    application/infrastructure/presentation code (RNF08).
 * 2. No JS numbers for money: Number(), parseFloat(), parseInt() and
 *    .toNumber() are banned in domain/ and in money mappers (README
 *    disqualifier).
 *
 *   bun scripts/check-architecture.ts
 */
import { Glob } from 'bun';

const root = `${__dirname}/..`;

const rules: { name: string; files: string; pattern: RegExp; exclude?: RegExp }[] = [
  {
    name: 'domain imports a framework or an outer layer',
    files: 'src/**/domain/**/*.ts',
    pattern: /from '(@nestjs\/|@mikro-orm\/|@aws-sdk\/|node:crypto|[^']*\/(application|infrastructure|presentation)\/)/,
  },
  {
    name: 'money handled as a JS number',
    files: 'src/**/{domain,infrastructure}/**/*.ts',
    pattern: /\b(Number\(|parseFloat\(|parseInt\(|\.toNumber\(\))/,
    exclude: /\.spec\.ts$|__fixtures__|\/sqs\/|\/observability\/|outbox-message\.ts$/,
  },
];

async function main(): Promise<void> {
  let violations = 0;
  for (const rule of rules) {
    for await (const file of new Glob(rule.files).scan({ cwd: root })) {
      if (rule.exclude?.test(file)) continue;
      const lines = (await Bun.file(`${root}/${file}`).text()).split('\n');
      lines.forEach((line, i) => {
        if (rule.pattern.test(line) && !line.includes('arch-allow')) {
          console.error(`${file}:${i + 1}  ${rule.name}\n    ${line.trim()}`);
          violations++;
        }
      });
    }
  }

  if (violations > 0) {
    console.error(`\n${violations} architecture violation(s)`);
    process.exit(1);
  }
  console.log('architecture: ok');
}

void main();
