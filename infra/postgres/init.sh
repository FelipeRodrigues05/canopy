#!/usr/bin/env bash
# Runs once, on the first boot of an empty Postgres volume.
#
# Two roles on purpose:
#   canopy_migrator  owns the schema and runs DDL (migrations only)
#   canopy_app       what the service connects with: DML only, and the ledger
#                    migration revokes UPDATE/DELETE on it from this role
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<SQL
CREATE ROLE canopy_migrator LOGIN PASSWORD '${MIGRATOR_PASSWORD:-migrator}';
CREATE ROLE canopy_app LOGIN PASSWORD '${APP_PASSWORD:-app}';
SQL

for db in ${CANOPY_DATABASES:-canopy}; do
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
    -c "CREATE DATABASE \"$db\" OWNER canopy_migrator"
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$db" <<SQL
ALTER SCHEMA public OWNER TO canopy_migrator;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO canopy_app;
ALTER DEFAULT PRIVILEGES FOR ROLE canopy_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO canopy_app;
ALTER DEFAULT PRIVILEGES FOR ROLE canopy_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO canopy_app;
ALTER DEFAULT PRIVILEGES FOR ROLE canopy_migrator IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO canopy_app;
SQL
done
