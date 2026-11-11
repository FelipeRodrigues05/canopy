function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (bun test loads .env.test)`);
  return value;
}

export const testEnv = {
  appDatabaseUrl: () => required('DATABASE_URL'),
  migratorDatabaseUrl: () => required('MIGRATOR_DATABASE_URL'),
};
