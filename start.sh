#!/bin/sh

# Exit on error
set -e

# Prisma SQLite URLs look like file:/database/alerts.db (mounted host file).
db_path="${DATABASE_URL#file:}"
db_existed=0
if [ -n "$db_path" ] && [ -f "$db_path" ]; then
    db_existed=1
fi

echo "Running database migrations..."
npx prisma migrate deploy

if [ "$db_existed" = "1" ]; then
    echo "Mounted database already present at $db_path; skipping seed"
else
    echo "No existing database file; seeding defaults..."
    npx prisma db seed
fi

echo "Starting application..."
npm start
